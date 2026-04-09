import { applyMiddleware } from './middleware';
import { IgnoredEventError } from './ignored-event-error';
import { log } from '../logger/logger';
import { EventConsumeStatus, EventMessage, RabbitMQResilientProcessorConfig } from '../types';

/**
 * Internal error used to short-circuit processing for unknown events when
 * `ignoreUnknownEvents` is enabled. The queue layer will nack the message
 * without requeueing so it is discarded immediately.
 */
class UnknownEventDiscardError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'UnknownEventDiscardError';
    }
}


/**
 * Handles the lifecycle of consuming events: deduplication, retries, and DLQ routing.
 *
 * Retry tracking uses a managed `x-retry-count` header instead of RabbitMQ's `x-death`
 * to avoid unreliable counting when multiple concurrent consumers race on the same retry queue.
 */
export class ResilientEventConsumeProcessor {
    constructor(private readonly config: RabbitMQResilientProcessorConfig) {}

    /**
     * Processes an event: applies middleware, deduplicates, invokes the handler,
     * and manages retries or DLQ routing on failure.
     */
    async process(event: EventMessage): Promise<void> {
        const { config } = this;
        const { store, eventsToProcess, events, middleware, retryQueue, ignoreUnknownEvents } = config;
        const retryCount = this.getRetryCount(event);
        const maxAttempts = retryQueue?.maxAttempts ?? 3;

        // Hard guard: already at or past the limit — route to DLQ immediately
        if (retryCount >= maxAttempts) {
            log('warn', `[Processor] Message ${event.messageId} exceeded max retries (${retryCount}/${maxAttempts})`);
            try {
                await this.sendToDlqOrDiscard(event, retryCount, new Error(`Max retry attempts (${maxAttempts}) exceeded`));
            } catch (dlqErr) {
                log('error', `[Processor] CRITICAL: Hard guard failed to route ${event.messageId} to DLQ. ` +
                    `Message will be ACKed to break nack loop. Error: ${(dlqErr as Error).message}`);
            }
            return;
        }

        try {
            // onEventStart hook with skip control
            const control = { skipEvent: false };
            events?.onEventStart?.(event, control);
            if (control.skipEvent) return;

            // Deduplication
            let existing = null;
            if (store) {
                existing = await store.getEvent(event);
            }

            const match = eventsToProcess.find(e => e.type === event.type);
            if (match) log('info', `[Processor] Processing ${event.messageId} (type: ${event.type}, attempt: ${retryCount + 1})`);

            if (existing && retryCount === 0) {
                log('warn', `[Processor] Duplicate event: ${event.messageId}, skipping`);
                return;
            } else if (existing) {
                if (store) await store.updateEventStatus(event, event.status as EventConsumeStatus);
            } else if (match || !ignoreUnknownEvents) {
                if (store) await store.saveEvent(event);
            }

            if (!match) {
                if (ignoreUnknownEvents) {
                    log('debug', `[Processor] Unknown event ${event.messageId} skipped immediately`);
                    throw new UnknownEventDiscardError(`Unknown event type: ${event.type}`);
                }

                if (store) {
                    await store.updateEventStatus(event, EventConsumeStatus.DONE);
                }
                return;
            }

            const runner = async () => {
                if (store) await store.updateEventStatus(event, EventConsumeStatus.PROCESSING);
                await match.handler(event);
                if (store) await store.updateEventStatus(event, EventConsumeStatus.DONE);
                events?.onSuccess?.(event);
            };

            if (middleware?.length) {
                await applyMiddleware(middleware, event, runner);
            } else {
                await runner();
            }

            log('info', `[Processor] Successfully processed ${event.messageId}`);

        } catch (err) {
            if (err instanceof UnknownEventDiscardError) {
                throw err;
            }

            if (err instanceof IgnoredEventError) {
                log('warn', `[Processor] Evento ${event.messageId} ignorado: ${err.message}`);
                if (store) {
                    await store.updateEventStatus(event, EventConsumeStatus.DONE);
                }
                events?.onSuccess?.(event);
                return;
            }
            log('error', `[Processor] Error processing ${event.messageId}: ${(err as Error).message}`);

            // Safety wrapper: failures in retry/DLQ logic must NOT propagate to avoid nack loops
            try {
                const currentAttempt = retryCount + 1;

                if (currentAttempt >= maxAttempts) {
                    await this.sendToDlqOrDiscard(event, currentAttempt, err as Error);
                    return;
                }

                if (store) {
                    await store.updateEventStatus(event, EventConsumeStatus.RETRY);
                }
                events?.onError?.(event, err as Error);

                if (retryQueue) {
                    await this.publishToRetryQueue(event, retryCount);
                } else {
                    await this.sendToDlqOrDiscard(event, currentAttempt, err as Error);
                }
            } catch (internalErr) {
                // CRITICAL: if retry/DLQ publishing fails, ACK the message to prevent infinite loops
                log('error', `[Processor] CRITICAL: Failed to handle error for ${event.messageId}. ` +
                    `Original: ${(err as Error).message}. Internal: ${(internalErr as Error).message}`);
            }
        }
    }

    // ─── Private helpers ───────────────────────────────────────────────────────

    private getRetryCount(event: EventMessage): number {
        const headers = event.properties?.headers;
        if (!headers) return 0;

        if (headers['x-retry-count'] != null) {
            const val = Number(headers['x-retry-count']);
            return Number.isFinite(val) && val >= 0 ? Math.floor(val) : 0;
        }

        // Fallback for in-flight messages during upgrades.
        // Only use x-death entries from the current consume queue to avoid
        // counting retries produced by other consumers/services.
        const death = headers['x-death'];
        if (Array.isArray(death) && death.length > 0) {
            const consumeQueue = this.config.consumeQueue.queue;
            const fromCurrentQueue = death.find((d: any) => d?.queue === consumeQueue);
            const rawCount = fromCurrentQueue?.count;
            const val = Number(rawCount !== undefined && rawCount !== null ? rawCount : 0);
            return Number.isFinite(val) && val >= 0 ? Math.floor(val) : 0;
        }

        return 0;
    }

    private async sendToDlqOrDiscard(event: EventMessage, retryCount: number, err: Error): Promise<void> {
        if (this.config.store) {
            await this.config.store.updateEventStatus(event, EventConsumeStatus.ERROR);
        }
        /* istanbul ignore next */
        this.config.events?.onError?.(event, err);

        if (this.config.deadLetterQueue) {
            const reason = (err as any).reason !== undefined ? (err as any).reason : 'rejected';
            const existingFirstDeathReason = event.properties?.headers?.['x-first-death-reason']; // eslint-disable-line
            const existingFirstDeathQueue = event.properties?.headers?.['x-first-death-queue']; // eslint-disable-line
            /* istanbul ignore next */
            const dlqRoutingKey = this.config.deadLetterQueue.exchange?.routingKey ?? event.routingKey;
            const dlqEvent: EventMessage = {
                ...event,
                routingKey: dlqRoutingKey,
                properties: {
                    ...event.properties,
                    headers: {
                        ...event.properties?.headers,
                        'x-error-message': err.message,
                        'x-error-name': err.name,
                        /* istanbul ignore next */
                        'x-error-stack': err.stack ?? '',
                        'x-death-count': retryCount,
                        'x-death-reason': reason,
                        'x-death-time': new Date().toISOString(),
                        'x-original-queue': this.config.consumeQueue.queue,
                        'x-first-death-reason': existingFirstDeathReason !== undefined ? existingFirstDeathReason : reason,
                        'x-first-death-queue': existingFirstDeathQueue !== undefined ? existingFirstDeathQueue : this.config.consumeQueue.queue,
                    },
                },
            };

            await this.config.broker.publish(
                this.config.deadLetterQueue.queue,
                dlqEvent,
                this.config.deadLetterQueue.exchange ? { exchange: this.config.deadLetterQueue.exchange } : undefined
            );
            log('info', `[Processor] Message ${event.messageId} sent to DLQ`);
            return;
        }

        log('warn', `[Processor] Message ${event.messageId} discarded (no DLQ configured)`);
    }

    private async publishToRetryQueue(event: EventMessage, retryCount: number): Promise<void> {
        const retryQueue = this.config.retryQueue!;
        const nextRetryCount = retryCount + 1;
        /* istanbul ignore next */
        const maxAttempts = retryQueue.maxAttempts ?? 3;
        log('warn', `[Processor] Retrying ${event.messageId} (attempt ${nextRetryCount}/${maxAttempts})`);

        const retryEvent: EventMessage = {
            ...event,
            routingKey: retryQueue.exchange?.routingKey ?? event.routingKey,
            properties: {
                ...event.properties,
                headers: { ...event.properties?.headers, 'x-retry-count': nextRetryCount },
            },
        };

        await this.config.broker.publish(
            retryQueue.queue,
            retryEvent,
            retryQueue.exchange ? { exchange: retryQueue.exchange } : undefined
        );
    }
}
