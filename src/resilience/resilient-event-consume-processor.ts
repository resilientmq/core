import {createHash, randomUUID} from 'crypto';
import {applyMiddleware} from './middleware';
import {IgnoredEventError} from './ignored-event-error';
import {isLogLevelEnabled, log} from '../logger/logger';
import {
    ConsumeClaimResult,
    DeliveryDisposition,
    EventConsumeStatus,
    EventMessage,
    EventProcessConfig,
    EventProcessingContext,
    RabbitMQResilientProcessorConfig,
    RawMessageDelivery
} from '../types';
import type {ResilienceMetricEvent} from '../metrics/metrics-collector';

/** Error raised when a handler exceeds its cooperative processing deadline. */
class ProcessingTimeoutError extends Error {
    constructor(timeoutMs: number) {
        super(`Event processing exceeded ${timeoutMs}ms`);
        this.name = 'ProcessingTimeoutError';
    }
}

/** Error raised when shutdown or connection replacement aborts a handler generation. */
class ProcessingAbortedError extends Error {
    constructor() {
        super('Event processing was aborted by the runtime');
        this.name = 'ProcessingAbortedError';
    }
}

/** Processes raw RabbitMQ deliveries with broker-owned retry accounting and fenced inbox claims. */
export class ResilientEventConsumeProcessor {
    private readonly eventHandlerMap: Map<string, EventProcessConfig>;
    private readonly activeControllers = new Set<AbortController>();
    private readonly serviceId: string;
    private readonly instanceId: string;

    constructor(private readonly config: RabbitMQResilientProcessorConfig) {
        this.eventHandlerMap = new Map(config.eventsToProcess.map(event => [event.type, event]));
        this.serviceId = config.resolvedServiceId ?? this.hashService(config.serviceId ?? config.consumeQueue.queue);
        this.instanceId = config.instanceId ?? randomUUID();
    }

    /** Parses and processes one raw delivery, including malformed-message retry limits. */
    async processRaw(delivery: RawMessageDelivery): Promise<DeliveryDisposition> {
        const messageId = this.resolveMessageId(delivery);
        const attempt = this.getDeliveryAttempt(delivery);
        this.emit({name: 'delivery.received', messageId, attempt});

        let payload: unknown;
        try {
            payload = JSON.parse(delivery.content.toString());
        } catch (error) {
            return this.handleMalformedDelivery(delivery, messageId, attempt, this.asError(error));
        }

        const type = this.headerString(delivery.properties.type)
            ?? this.headerString(delivery.properties.headers?.['x-event-type']);
        const event: EventMessage = {
            messageId,
            type,
            payload,
            status: EventConsumeStatus.RECEIVED,
            properties: delivery.properties,
            routingKey: delivery.routingKey || undefined
        };
        return this.process(event, {
            attempt,
            redelivered: delivery.redelivered,
            rawContent: delivery.content
        });
    }

    /** Processes one decoded event and returns the AMQP delivery disposition. */
    async process(
        event: EventMessage,
        delivery: {attempt?: number; redelivered?: boolean; rawContent?: Buffer} = {}
    ): Promise<DeliveryDisposition> {
        const attempt = delivery.attempt ?? this.getAttemptFromHeaders(event.properties?.headers);
        const maxAttempts = this.config.retryQueue?.maxAttempts ?? 3;
        const match = event.type ? this.eventHandlerMap.get(event.type) : undefined;

        if (!match && (this.config.ignoreUnknownEvents ?? true)) {
            if (isLogLevelEnabled('debug')) log('debug', `[Processor] Ignored unknown event ${event.messageId}`);
            return 'ack';
        }

        const claim = await this.claim(event, attempt);
        if (claim.outcome === 'completed') {
            this.emit({name: 'delivery.duplicate', messageId: event.messageId, attempt});
            return 'ack';
        }
        if (claim.outcome === 'busy') {
            this.emit({name: 'delivery.lease_busy', messageId: event.messageId, attempt});
            const remainingLeaseMs = Math.max(0, claim.leaseExpiresAt - Date.now());
            await this.sleep(Math.min(250, Math.max(25, remainingLeaseMs)));
            return 'requeue';
        }

        if (attempt > maxAttempts) {
            return this.deadLetterOrDiscard(
                event,
                attempt,
                new Error(`Maximum delivery attempts (${maxAttempts}) exceeded`),
                claim,
                delivery.rawContent ?? Buffer.from(JSON.stringify(event.payload))
            );
        }

        const controller = new AbortController();
        this.activeControllers.add(controller);
        const context: EventProcessingContext = {
            signal: controller.signal,
            attempt,
            serviceId: this.serviceId,
            instanceId: this.instanceId,
            deliveryId: randomUUID(),
            redelivered: delivery.redelivered ?? false,
            fencingToken: claim.fencingToken
        };
        const startedAt = Date.now();

        try {
            const control = {skipEvent: false};
            this.config.events?.onEventStart?.(event, control);
            if (!control.skipEvent && match) {
                await this.runHandler(event, match, context, controller);
            }

            const completed = await this.transition(event, claim, EventConsumeStatus.DONE);
            if (!completed) return 'requeue';
            this.safeOnSuccess(event);
            this.emit({
                name: 'consume.completed',
                messageId: event.messageId,
                attempt,
                durationMs: Date.now() - startedAt
            });
            return 'ack';
        } catch (error) {
            const failure = this.asError(error);
            if (failure instanceof IgnoredEventError) {
                const completed = await this.transition(event, claim, EventConsumeStatus.DONE);
                if (!completed) return 'requeue';
                this.safeOnSuccess(event);
                return 'ack';
            }

            if (failure instanceof ProcessingAbortedError) {
                return 'requeue';
            }

            this.safeOnError(event, failure);
            if (!this.config.retryQueue || attempt >= maxAttempts) {
                return this.deadLetterOrDiscard(
                    event,
                    attempt,
                    failure,
                    claim,
                    delivery.rawContent ?? Buffer.from(JSON.stringify(event.payload))
                );
            }

            if (!(failure instanceof ProcessingTimeoutError)) {
                try {
                    const transitioned = await this.transition(event, claim, EventConsumeStatus.RETRY, failure);
                    if (!transitioned) return 'requeue';
                } catch (storeError) {
                    log('error', `[Processor] Failed to persist retry status for ${event.messageId}`, storeError);
                }
            }
            this.emit({name: 'consume.retry_scheduled', messageId: event.messageId, attempt, errorName: failure.name});
            return this.retryDisposition();
        } finally {
            controller.abort();
            this.activeControllers.delete(controller);
        }
    }

    /** Cooperatively aborts every active handler generation. */
    abortActive(): void {
        for (const controller of this.activeControllers) controller.abort();
    }

    /** Calculates a one-based attempt from RabbitMQ-owned delivery headers. */
    getDeliveryAttempt(delivery: RawMessageDelivery): number {
        return this.getAttemptFromHeaders(delivery.properties.headers);
    }

    private async claim(event: EventMessage, attempt: number): Promise<ConsumeClaimResult> {
        const store = this.config.store;
        if (!store) {
            return {outcome: 'acquired', fencingToken: randomUUID(), leaseExpiresAt: Number.MAX_SAFE_INTEGER};
        }

        if (store.claimConsumeEvent) {
            return store.claimConsumeEvent({
                event,
                attempt,
                serviceId: this.serviceId,
                instanceId: this.instanceId,
                leaseDurationMs: this.config.processingLeaseMs ?? 330000,
                now: Date.now()
            });
        }

        const existing = await store.getEvent(event);
        if (existing?.status === EventConsumeStatus.DONE || existing?.status === EventConsumeStatus.ERROR) {
            return {outcome: 'completed'};
        }
        if (!existing) await store.saveEvent({...event, status: EventConsumeStatus.PROCESSING});
        await store.updateEventStatus(event, EventConsumeStatus.PROCESSING);
        return {outcome: 'acquired', fencingToken: undefined as never, leaseExpiresAt: Number.MAX_SAFE_INTEGER};
    }

    private async transition(
        event: EventMessage,
        claim: Extract<ConsumeClaimResult, {outcome: 'acquired'}>,
        status: EventConsumeStatus.DONE | EventConsumeStatus.RETRY | EventConsumeStatus.ERROR,
        error?: Error
    ): Promise<boolean> {
        const store = this.config.store;
        if (!store) return true;
        if (store.transitionConsumeEvent && claim.fencingToken !== undefined) {
            return store.transitionConsumeEvent({
                event,
                fencingToken: claim.fencingToken,
                serviceId: this.serviceId,
                instanceId: this.instanceId,
                status,
                now: Date.now(),
                error
            });
        }
        await store.updateEventStatus(event, status);
        return true;
    }

    private async runHandler(
        event: EventMessage,
        match: EventProcessConfig,
        context: EventProcessingContext,
        controller: AbortController
    ): Promise<void> {
        let rejectAbort!: (error: Error) => void;
        const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
        const onAbort = () => rejectAbort(new ProcessingAbortedError());
        context.signal.addEventListener('abort', onAbort, {once: true});
        const runner = async () => match.handler(event, context);
        const operation = this.config.middleware?.length
            ? applyMiddleware(this.config.middleware, event, runner)
            : runner();
        const timeoutMs = this.config.processingTimeoutMs ?? 300000;
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const deadline = new Promise<never>((_, reject) => {
            timeout = setTimeout(() => {
                reject(new ProcessingTimeoutError(timeoutMs));
                controller.abort();
            }, timeoutMs);
        });

        try {
            await Promise.race([operation, deadline, aborted]);
        } finally {
            if (timeout) clearTimeout(timeout);
            context.signal.removeEventListener('abort', onAbort);
        }
    }

    private async handleMalformedDelivery(
        delivery: RawMessageDelivery,
        messageId: string,
        attempt: number,
        error: Error
    ): Promise<DeliveryDisposition> {
        const maxAttempts = this.config.retryQueue?.maxAttempts ?? 3;
        if (this.config.retryQueue && attempt < maxAttempts) {
            this.emit({name: 'consume.retry_scheduled', messageId, attempt, errorName: error.name});
            return this.retryDisposition();
        }

        const event: EventMessage = {
            messageId,
            type: this.headerString(delivery.properties.type),
            payload: null,
            properties: delivery.properties,
            routingKey: delivery.routingKey || undefined
        };
        const claim = await this.claim(event, attempt);
        if (claim.outcome === 'completed') return 'ack';
        if (claim.outcome === 'busy') {
            const remainingLeaseMs = Math.max(0, claim.leaseExpiresAt - Date.now());
            await this.sleep(Math.min(250, Math.max(25, remainingLeaseMs)));
            return 'requeue';
        }
        return this.deadLetterOrDiscard(
            event,
            attempt,
            new SyntaxError(`Malformed JSON: ${error.message}`),
            claim,
            delivery.content
        );
    }

    private async deadLetterOrDiscard(
        event: EventMessage,
        attempt: number,
        error: Error,
        claim: Extract<ConsumeClaimResult, {outcome: 'acquired'}>,
        content: Buffer
    ): Promise<DeliveryDisposition> {
        const deadLetterQueue = this.config.deadLetterQueue;
        if (deadLetterQueue) {
            try {
                await this.config.broker.publishRaw(
                    deadLetterQueue.queue,
                    content,
                    {
                        ...event.properties,
                        messageId: event.messageId,
                        type: event.type,
                        headers: {
                            ...(event.properties?.headers ?? {}),
                            'x-resilientmq-error-message': error.message,
                            'x-resilientmq-error-name': error.name,
                            'x-resilientmq-attempt': attempt,
                            'x-resilientmq-original-queue': this.config.consumeQueue.queue,
                            'x-resilientmq-service-id': this.serviceId
                        }
                    },
                    {
                        exchange: deadLetterQueue.exchange,
                        routingKey: deadLetterQueue.exchange?.routingKey ?? event.routingKey
                    }
                );
            } catch (publishError) {
                log('error', `[Processor] Failed to confirm DLQ publication for ${event.messageId}`, publishError);
                return this.retryDisposition();
            }
        }

        try {
            const transitioned = await this.transition(event, claim, EventConsumeStatus.ERROR, error);
            if (!transitioned) return 'requeue';
        } catch (storeError) {
            log('error', `[Processor] Failed to persist terminal status for ${event.messageId}`, storeError);
            return 'requeue';
        }
        this.emit({name: 'consume.failed', messageId: event.messageId, attempt, errorName: error.name});
        if (deadLetterQueue) this.emit({name: 'consume.dead_lettered', messageId: event.messageId, attempt});
        return 'ack';
    }

    private retryDisposition(): DeliveryDisposition {
        return this.config.retryQueue ? 'reject' : 'requeue';
    }

    private async sleep(ms: number): Promise<void> {
        await new Promise(resolve => setTimeout(resolve, ms));
    }

    private getAttemptFromHeaders(headers: Record<string, unknown> | undefined): number {
        let previousFailures = 0;
        const deliveryCount = Math.max(
            this.nonNegativeInteger(headers?.['x-delivery-count']),
            this.nonNegativeInteger(headers?.['x-acquired-count'])
        );
        previousFailures = Math.max(previousFailures, deliveryCount);

        const deaths = headers?.['x-death'];
        if (Array.isArray(deaths)) {
            for (const death of deaths) {
                if (!death || typeof death !== 'object') continue;
                const entry = death as Record<string, unknown>;
                if (entry.queue !== this.config.consumeQueue.queue || entry.reason !== 'rejected') continue;
                previousFailures = Math.max(previousFailures, this.nonNegativeInteger(entry.count));
            }
        }
        return previousFailures + 1;
    }

    private resolveMessageId(delivery: RawMessageDelivery): string {
        return this.headerString(delivery.properties.messageId)
            ?? this.headerString(delivery.properties.headers?.['x-message-id'])
            ?? createHash('sha256')
                .update(delivery.exchange)
                .update('\0')
                .update(delivery.routingKey)
                .update('\0')
                .update(delivery.content)
                .digest('hex');
    }

    private nonNegativeInteger(value: unknown): number {
        const parsed = Number(value);
        return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0;
    }

    private headerString(value: unknown): string | undefined {
        return typeof value === 'string' && value.length > 0 ? value : undefined;
    }

    private hashService(value: string): string {
        return createHash('sha256').update(value).digest('hex');
    }

    private safeOnError(event: EventMessage, error: Error): void {
        try {
            this.config.events?.onError?.(event, error);
        } catch (hookError) {
            log('warn', `[Processor] onError hook failed for ${event.messageId}`, hookError);
        }
    }

    private safeOnSuccess(event: EventMessage): void {
        try {
            this.config.events?.onSuccess?.(event);
        } catch (hookError) {
            log('warn', `[Processor] onSuccess hook failed for ${event.messageId}`, hookError);
        }
    }

    private emit(event: Omit<ResilienceMetricEvent, 'timestamp' | 'serviceId' | 'instanceId'>): void {
        try {
            const result = this.config.metricsSink?.emit({
                ...event,
                timestamp: Date.now(),
                serviceId: this.serviceId,
                instanceId: this.instanceId
            });
            if (result && typeof result.catch === 'function') result.catch(() => undefined);
        } catch {}
    }

    private asError(error: unknown): Error {
        return error instanceof Error ? error : new Error(String(error));
    }
}
