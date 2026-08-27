import {createHash, randomUUID} from 'crypto';
import {AmqpQueue} from '../broker/amqp-queue';
import {isLogLevelEnabled, log} from '../logger/logger';
import {
    ClaimedPublishEvent,
    EventMessage,
    EventPublishStatus,
    ProcessPendingEventsOptions,
    ResilientPublisherConfig
} from '../types';
import {MetricsCollector, MetricsSink, ResilienceMetricEvent, ResilientMQMetrics} from '../metrics/metrics-collector';

/** Confirmed RabbitMQ publisher with a lease-based distributed outbox worker. */
export class ResilientEventPublisher {
    private readonly queue: AmqpQueue;
    private readonly instanceId = randomUUID();
    private readonly serviceId: string;
    private readonly instantPublish: boolean;
    private readonly maxConcurrentPublishes: number;
    private readonly metrics?: MetricsCollector;
    private readonly metricsSink?: MetricsSink;
    private readonly publishWaiters: Array<() => void> = [];
    private activePublishes = 0;
    private connected = false;
    private connectPromise?: Promise<void>;
    private recoveryPromise?: Promise<void>;
    private pendingEventsInterval?: ReturnType<typeof setInterval>;
    private pendingPass?: Promise<void>;
    private disconnectPromise?: Promise<void>;
    private stopping = false;

    constructor(private readonly config: ResilientPublisherConfig) {
        this.validateConfig();
        this.instantPublish = config.instantPublish !== false;
        this.maxConcurrentPublishes = config.maxConcurrentPublishes ?? 100;
        this.serviceId = createHash('sha256')
            .update(config.serviceId ?? config.queue ?? config.exchange?.name ?? 'publisher')
            .update('\0')
            .update(config.queue ?? config.exchange?.name ?? '')
            .digest('hex');
        this.metrics = config.metricsEnabled ? new MetricsCollector() : undefined;
        this.metricsSink = this.composeMetricsSink(this.metrics, config.metricsSink);
        this.queue = new AmqpQueue(config.connection);
        this.queue.onDisconnect(disconnect => {
            this.connected = false;
            this.emit({name: 'broker.disconnected', errorName: disconnect.error?.name});
        });

        if (!this.instantPublish && config.pendingEventsCheckIntervalMs && config.pendingEventsCheckIntervalMs > 0) {
            this.startPendingEventsCheck();
        }
    }

    /** Returns the optional in-process aggregate snapshot. */
    getMetrics(): ResilientMQMetrics | undefined { return this.metrics?.getSnapshot(); }

    /** Enqueues an event idempotently and optionally publishes its acquired outbox claim. */
    async publish(event: EventMessage, options: {storeOnly?: boolean} = {}): Promise<void> {
        if (this.stopping) throw new Error('[Publisher] Cannot publish while disconnecting');
        const store = this.config.store;
        const pendingEvent = {...event, status: EventPublishStatus.PENDING};

        if (!store) {
            if (options.storeOnly) {
                throw new Error('[Publisher] storeOnly requires a configured store');
            }
            await this.publishConfirmed(pendingEvent);
            return;
        }

        const inserted = await store.saveEventIfNotExists!(pendingEvent);
        if (!inserted) {
            const existing = await store.getEvent(pendingEvent);
            if (existing?.status === EventPublishStatus.PUBLISHED) {
                if (isLogLevelEnabled('warn')) log('warn', `[Publisher] Duplicate ${event.messageId} already published`);
                return;
            }
        }

        if (options.storeOnly || !this.instantPublish) return;

        const claim = await store.claimPublishEvent!({
            event: pendingEvent,
            serviceId: this.serviceId,
            instanceId: this.instanceId,
            leaseDurationMs: this.config.outboxLeaseMs ?? 30000,
            now: Date.now()
        });
        if (!claim) return;
        await this.publishClaim(claim);
    }

    /** Claims and processes pending outbox rows with one rate gate across all batches. */
    async processPendingEvents(options: ProcessPendingEventsOptions = {}): Promise<void> {
        if (this.stopping) return;
        if (this.pendingPass) return this.pendingPass;
        const pass = this.processPendingEventsInternal(options).finally(() => {
            this.pendingPass = undefined;
        });
        this.pendingPass = pass;
        return pass;
    }

    /** Closes the long-lived confirm connection after active publications drain. */
    async disconnect(): Promise<void> {
        if (this.disconnectPromise) return this.disconnectPromise;
        this.disconnectPromise = this.disconnectInternal().finally(() => {
            this.disconnectPromise = undefined;
        });
        return this.disconnectPromise;
    }

    private async disconnectInternal(): Promise<void> {
        this.stopping = true;
        for (const resume of this.publishWaiters.splice(0)) resume();
        try {
            this.stopPendingEventsCheck();
            const timeoutMs = this.config.shutdownTimeoutMs ?? 30000;
            const deadline = Date.now() + timeoutMs;
            while ((this.pendingPass || this.activePublishes > 0) && Date.now() < deadline) {
                await new Promise(resolve => setTimeout(resolve, 10));
            }
            if (this.pendingPass || this.activePublishes > 0) {
                await this.queue.forceClose();
            } else {
                await this.queue.disconnect(Math.max(1, deadline - Date.now()));
            }
            this.connected = false;
        } finally {
            this.stopping = false;
        }
    }

    /** Stops automatic outbox checks without closing RabbitMQ. */
    stopPendingEventsCheck(): void {
        if (this.pendingEventsInterval) clearInterval(this.pendingEventsInterval);
        this.pendingEventsInterval = undefined;
    }

    /** Indicates whether the confirm channel is currently available. */
    isConnected(): boolean { return this.connected && !this.queue.closed; }

    private async processPendingEventsInternal(options: ProcessPendingEventsOptions): Promise<void> {
        const store = this.config.store;
        if (!store?.claimPendingEvents || !store.completePublishedEvent || !store.releasePublishEvent) {
            throw new Error('[Publisher] Distributed pending processing requires claimPendingEvents(), completePublishedEvent() and releasePublishEvent()');
        }

        const batchSize = options.batchSize ?? this.config.pendingEventsBatchSize ?? 100;
        const rate = options.maxPublishesPerSecond
            ?? this.config.pendingEventsMaxPublishesPerSecond;
        const concurrency = Math.min(
            options.maxConcurrentPublishes
                ?? this.config.pendingEventsMaxConcurrentPublishes
                ?? this.maxConcurrentPublishes,
            this.maxConcurrentPublishes
        );
        this.assertPositiveInteger('batchSize', batchSize);
        if (rate !== undefined) this.assertPositiveInteger('maxPublishesPerSecond', rate);
        this.assertPositiveInteger('maxConcurrentPublishes', concurrency);

        const seen = new Set<string>();
        let nextPublicationAt = Date.now();
        const waitForRate = async () => {
            if (rate === undefined) return;
            const scheduledAt = Math.max(Date.now(), nextPublicationAt);
            nextPublicationAt = scheduledAt + (1000 / rate);
            const wait = scheduledAt - Date.now();
            if (wait > 0) await this.sleep(wait);
        };

        while (!this.stopping) {
            const claims = await store.claimPendingEvents({
                serviceId: this.serviceId,
                instanceId: this.instanceId,
                limit: batchSize,
                leaseDurationMs: this.config.outboxLeaseMs ?? 30000,
                now: Date.now()
            });
            const freshClaims = claims.filter(claim => !seen.has(claim.event.messageId));
            if (freshClaims.length === 0) return;
            for (const claim of freshClaims) seen.add(claim.event.messageId);
            this.emit({name: 'outbox.claimed'});

            let index = 0;
            const workers = Array.from({length: Math.min(concurrency, freshClaims.length)}, async () => {
                while (!this.stopping && index < freshClaims.length) {
                    const claim = freshClaims[index++];
                    await waitForRate();
                    if (this.stopping) return;
                    try {
                        await this.publishClaim(claim);
                    } catch (error) {
                        log('error', `[Publisher] Pending publication failed for ${claim.event.messageId}`, error);
                    }
                }
            });
            await Promise.all(workers);
            if (this.stopping || claims.length < batchSize) return;
        }
    }

    private async publishClaim(claim: ClaimedPublishEvent): Promise<void> {
        const store = this.config.store;
        if (!store?.completePublishedEvent || !store.releasePublishEvent) {
            throw new Error('[Publisher] Claimed publication requires fenced store transitions');
        }

        try {
            await this.publishConfirmed(claim.event);
            const completed = await store.completePublishedEvent({
                event: claim.event,
                fencingToken: claim.fencingToken,
                serviceId: this.serviceId,
                instanceId: this.instanceId,
                now: Date.now()
            });
            if (!completed) {
                throw new Error(`[Publisher] Lost fencing ownership after confirming ${claim.event.messageId}`);
            }
        } catch (error) {
            const failure = this.asError(error);
            try {
                const released = await store.releasePublishEvent({
                    event: claim.event,
                    fencingToken: claim.fencingToken,
                    serviceId: this.serviceId,
                    instanceId: this.instanceId,
                    now: Date.now(),
                    nextAttemptAt: Date.now() + (this.config.outboxRetryDelayMs ?? 5000),
                    error: failure
                });
                if (released) {
                    this.emit({name: 'outbox.released', messageId: claim.event.messageId, errorName: failure.name});
                } else {
                    log('warn', `[Publisher] Lost fencing ownership while releasing ${claim.event.messageId}`);
                }
            } catch (releaseError) {
                log('error', `[Publisher] Claim release failed for ${claim.event.messageId}; lease expiry will recover it`, releaseError);
            }
            this.emit({name: 'publish.failed', messageId: claim.event.messageId, errorName: failure.name});
            throw failure;
        }
    }

    private async publishConfirmed(event: EventMessage): Promise<void> {
        await this.acquirePublishSlot();
        const startedAt = Date.now();
        try {
            const outbound: EventMessage = {
                ...event,
                properties: {
                    ...event.properties,
                    headers: {
                        ...(event.properties?.headers ?? {}),
                        'x-resilientmq-service-id': this.serviceId,
                        'x-resilientmq-instance-id': this.instanceId
                    }
                }
            };
            await this.ensureConnected();
            try {
                await this.queue.publish(
                    this.config.queue ?? this.config.exchange!.name,
                    outbound,
                    {
                        exchange: this.config.exchange,
                        routingKey: outbound.routingKey ?? this.config.exchange?.routingKey,
                        confirmTimeoutMs: this.config.confirmTimeoutMs
                    }
                );
            } catch (error) {
                if (this.stopping) throw error;
                await this.recoverConnection();
                await this.queue.publish(
                    this.config.queue ?? this.config.exchange!.name,
                    outbound,
                    {
                        exchange: this.config.exchange,
                        routingKey: outbound.routingKey ?? this.config.exchange?.routingKey,
                        confirmTimeoutMs: this.config.confirmTimeoutMs
                    }
                );
            }
            this.emit({
                name: 'publish.confirmed',
                messageId: event.messageId,
                durationMs: Date.now() - startedAt
            });
            if (isLogLevelEnabled('info')) log('info', `[Publisher] Confirmed ${event.messageId}`);
        } finally {
            this.releasePublishSlot();
        }
    }

    private async ensureConnected(): Promise<void> {
        if (this.connected && !this.queue.closed) return;
        if (this.connectPromise) return this.connectPromise;
        this.connectPromise = this.queue.connect().then(() => {
            this.connected = true;
            this.emit({name: 'broker.connected'});
        }).finally(() => {
            this.connectPromise = undefined;
        });
        return this.connectPromise;
    }

    private async recoverConnection(): Promise<void> {
        if (this.recoveryPromise) return this.recoveryPromise;
        this.recoveryPromise = (async () => {
            this.connected = false;
            await this.queue.forceClose();
            await this.ensureConnected();
        })().finally(() => {
            this.recoveryPromise = undefined;
        });
        return this.recoveryPromise;
    }

    private startPendingEventsCheck(): void {
        this.pendingEventsInterval = setInterval(() => {
            if (this.stopping) return;
            this.processPendingEvents().catch(error => {
                log('error', '[Publisher] Automatic pending pass failed', error);
            });
        }, this.config.pendingEventsCheckIntervalMs);
    }

    private async acquirePublishSlot(): Promise<void> {
        if (this.stopping) throw new Error('[Publisher] Cannot publish while disconnecting');
        if (this.activePublishes >= this.maxConcurrentPublishes) {
            await new Promise<void>(resolve => this.publishWaiters.push(resolve));
            if (this.stopping) throw new Error('[Publisher] Publication cancelled by disconnect');
        }
        this.activePublishes++;
    }

    private releasePublishSlot(): void {
        this.activePublishes--;
        this.publishWaiters.shift()?.();
    }

    private composeMetricsSink(first?: MetricsSink, second?: MetricsSink): MetricsSink | undefined {
        const sinks = [first, second].filter((sink): sink is MetricsSink => sink !== undefined);
        if (sinks.length === 0) return undefined;
        return {
            emit: event => {
                for (const sink of sinks) {
                    try {
                        const result = sink.emit(event);
                        if (result && typeof result.catch === 'function') result.catch(() => undefined);
                    } catch {}
                }
            }
        };
    }

    private emit(event: Omit<ResilienceMetricEvent, 'timestamp' | 'serviceId' | 'instanceId'>): void {
        try {
            const result = this.metricsSink?.emit({
                ...event,
                timestamp: Date.now(),
                serviceId: this.serviceId,
                instanceId: this.instanceId
            });
            if (result && typeof result.catch === 'function') result.catch(() => undefined);
        } catch {}
    }

    private assertPositiveInteger(name: string, value: number): void {
        if (!Number.isInteger(value) || value <= 0) {
            throw new Error(`[Publisher] Configuration error: "${name}" must be a positive integer`);
        }
    }

    private validateConfig(): void {
        if (!this.config.queue && !this.config.exchange) {
            throw new Error('[Publisher] Configuration error: either "queue" or "exchange" must be configured');
        }
        this.assertPositiveInteger('maxConcurrentPublishes', this.config.maxConcurrentPublishes ?? 100);
        const confirmTimeout = this.config.confirmTimeoutMs ?? 10000;
        const lease = this.config.outboxLeaseMs ?? 30000;
        if (!Number.isFinite(confirmTimeout) || confirmTimeout <= 0) {
            throw new Error('[Publisher] Configuration error: "confirmTimeoutMs" must be positive and finite');
        }
        if (!Number.isFinite(lease) || lease <= 0) {
            throw new Error('[Publisher] Configuration error: "outboxLeaseMs" must be positive and finite');
        }
        if (this.config.store && lease <= confirmTimeout * 2) {
            throw new Error('[Publisher] Configuration error: "outboxLeaseMs" must exceed two confirm timeouts');
        }
        const shutdownTimeout = this.config.shutdownTimeoutMs ?? 30000;
        if (!Number.isFinite(shutdownTimeout) || shutdownTimeout <= 0) {
            throw new Error('[Publisher] Configuration error: "shutdownTimeoutMs" must be positive');
        }
        this.assertOptionalPositiveInteger('pendingEventsCheckIntervalMs', this.config.pendingEventsCheckIntervalMs);
        this.assertOptionalPositiveInteger('pendingEventsBatchSize', this.config.pendingEventsBatchSize);
        this.assertOptionalPositiveInteger(
            'pendingEventsMaxPublishesPerSecond',
            this.config.pendingEventsMaxPublishesPerSecond
        );
        this.assertOptionalPositiveInteger(
            'pendingEventsMaxConcurrentPublishes',
            this.config.pendingEventsMaxConcurrentPublishes
        );
        if (this.config.outboxRetryDelayMs !== undefined
            && (!Number.isFinite(this.config.outboxRetryDelayMs) || this.config.outboxRetryDelayMs < 0)) {
            throw new Error('[Publisher] Configuration error: "outboxRetryDelayMs" must be non-negative and finite');
        }
        const store = this.config.store;
        if (store && (!store.saveEventIfNotExists || !store.claimPublishEvent
            || !store.completePublishedEvent || !store.releasePublishEvent)) {
            throw new Error('[Publisher] Configuration error: store requires idempotent enqueue and fenced publication methods');
        }
        if (this.config.instantPublish === false) {
            if (!store?.claimPendingEvents) {
                throw new Error('[Publisher] Deferred publishing requires distributed outbox claim and fencing methods');
            }
        }
    }

    private assertOptionalPositiveInteger(name: string, value: number | undefined): void {
        if (value !== undefined) this.assertPositiveInteger(name, value);
    }

    private asError(error: unknown): Error {
        return error instanceof Error ? error : new Error(String(error));
    }

    private async sleep(ms: number): Promise<void> {
        await new Promise(resolve => setTimeout(resolve, ms));
    }
}
