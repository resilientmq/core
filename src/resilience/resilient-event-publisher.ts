import { AmqpQueue } from '../broker/amqp-queue';
import { log } from '../logger/logger';
import {
    EventMessage,
    EventPublishStatus,
    ProcessPendingEventsOptions,
    ResilientPublisherConfig
} from '../types';
import { MetricsCollector, ResilientMQMetrics } from '../metrics/metrics-collector';

export class ResilientEventPublisher {
    private readonly queue: AmqpQueue;
    private pendingEventsInterval?: NodeJS.Timeout;
    private idleTimer?: NodeJS.Timeout;
    private connectPromise?: Promise<void>;
    private reconnectPromise?: Promise<void>;
    private readonly instantPublish: boolean;
    private storeConnected = false;
    private connected = false;
    private lastPublishTime = 0;
    private pendingOperations = 0;
    private isProcessingPending = false;
    private readonly maxConcurrentPublishes: number;
    private readonly metrics?: MetricsCollector;

    public getMetrics(): ResilientMQMetrics | undefined {
        return this.metrics?.getSnapshot();
    }

    constructor(private readonly config: ResilientPublisherConfig) {
        this.maxConcurrentPublishes = config.maxConcurrentPublishes ?? 100;
        this.validateConfig();
        this.instantPublish = config.instantPublish !== false;
        this.queue = new AmqpQueue(this.config.connection);

        if (config.metricsEnabled) {
            this.metrics = new MetricsCollector();
        }

        if (this.config.store) {
            try {
                const connectionCheck = this.checkStoreConnection();
                connectionCheck.catch(error => {
                    this.storeConnected = false;
                    this.metrics?.increment('processingErrors');
                    log('error', '[Publisher] Failed to connect to store during initialization', error);
                    this.handleStoreInitFailure();
                });
            } catch (error) {
                this.storeConnected = false;
                this.metrics?.increment('processingErrors');
                log('error', '[Publisher] Failed to connect to store during initialization', error);
                this.handleStoreInitFailure();
            }
        }

        if (!this.instantPublish && this.config.pendingEventsCheckIntervalMs && this.config.pendingEventsCheckIntervalMs > 0) {
            this.startPendingEventsCheck();
        }
    }

    async publish(event: EventMessage, options?: { storeOnly?: boolean }): Promise<void> {
        while (this.pendingOperations >= this.maxConcurrentPublishes) {
            await this.sleep(10);
        }

        this.pendingOperations++;

        try {
            const store = this.config.store;
            const shouldPublishNow = !options?.storeOnly && (this.instantPublish || !store);

            if (store) {
                if (!this.storeConnected) {
                    await this.checkStoreConnection();
                }

                const existing = await store.getEvent(event);
                if (existing) {
                    log('warn', `[Publisher] Duplicate message: ${event.messageId}, skipping`);
                    return;
                }

                event.status = EventPublishStatus.PENDING;
                await store.saveEvent(event);
            } else {
                event.status = EventPublishStatus.PENDING;
            }

            if (shouldPublishNow) {
                await this.publishToBroker(event);

                if (store) {
                    await store.updateEventStatus(event, EventPublishStatus.PUBLISHED);
                }

                this.metrics?.increment('messagesPublished');
                log('info', `[Publisher] Published ${event.messageId}`);
            } else {
                log('debug', `[Publisher] Stored ${event.messageId} for later delivery`);
            }
        } catch (error) {
            this.metrics?.increment('processingErrors');
            log('error', `[Publisher] Failed to publish ${event.messageId}`, error);

            if (this.config.store) {
                try {
                    await this.config.store.updateEventStatus(event, EventPublishStatus.ERROR);
                } catch {}
            }

            throw error;
        } finally {
            this.pendingOperations--;
        }
    }

    async processPendingEvents(options: ProcessPendingEventsOptions = {}): Promise<void> {
        if (!this.config.store) {
            log('warn', '[Publisher] Cannot process pending events: no store configured');
            return;
        }

        if (!this.config.store.getPendingEvents) {
            throw new Error('Store must implement getPendingEvents() method');
        }

        if (this.isProcessingPending) {
            log('debug', '[Publisher] Pending events processing already in progress, skipping');
            return;
        }

        const batchSize = options.batchSize ?? this.config.pendingEventsBatchSize ?? 100;
        this.assertPositiveInteger('batchSize', batchSize);

        this.isProcessingPending = true;
        this.pendingOperations++;

        try {
            if (!this.storeConnected) {
                await this.checkStoreConnection();
            }

            await this.connect();
            this.resetIdleTimer();

            let totalSuccess = 0;
            let totalErrors = 0;
            let batchNumber = 0;
            const startTime = Date.now();

            while (true) {
                batchNumber++;

                const rawResult = await this.config.store.getPendingEvents(EventPublishStatus.PENDING, batchSize);
                const pendingEvents: EventMessage[] = Array.isArray(rawResult)
                    ? rawResult
                    : Array.from(rawResult as Iterable<EventMessage>);

                if (!pendingEvents.length) {
                    break;
                }

                const sorted = pendingEvents.sort(
                    (a, b) => (a.properties?.timestamp || 0) - (b.properties?.timestamp || 0)
                );

                // Process all events in parallel - maximum speed
                const results = await Promise.allSettled(
                    sorted.map(async (event) => {
                        try {
                            await this.publishToBroker(event);
                            return { event, status: EventPublishStatus.PUBLISHED, success: true };
                        } catch (error) {
                            this.metrics?.increment('processingErrors');
                            log('error', `[Publisher] Failed to publish pending event ${event.messageId}`, error);
                            return { event, status: EventPublishStatus.ERROR, success: false };
                        }
                    })
                );

                // Collect results
                const updates: Array<{ event: EventMessage; status: EventPublishStatus }> = [];
                for (const result of results) {
                    if (result.status === 'fulfilled') {
                        updates.push({ event: result.value.event, status: result.value.status });
                        if (result.value.success) {
                            totalSuccess++;
                            this.metrics?.increment('messagesPublished');
                        } else {
                            totalErrors++;
                        }
                    }
                }

                // Batch update all statuses at once
                if (updates.length > 0) {
                    if (this.config.store.batchUpdateEventStatus) {
                        try {
                            await this.config.store.batchUpdateEventStatus(updates);
                        } catch (error) {
                            log('error', '[Publisher] Batch status update failed, falling back to individual updates', error);
                            await Promise.all(
                                updates.map(({ event, status }) =>
                                    this.config.store!.updateEventStatus(event, status).catch(() => {})
                                )
                            );
                        }
                    } else {
                        await Promise.all(
                            updates.map(({ event, status }) =>
                                this.config.store!.updateEventStatus(event, status).catch(() => {})
                            )
                        );
                    }
                }

                if (pendingEvents.length < batchSize) {
                    break;
                }
            }

            const elapsed = Date.now() - startTime;
            const actualRate = elapsed > 0 ? Math.round((totalSuccess / elapsed) * 1000) : 0;

            if (totalSuccess > 0 || totalErrors > 0) {
                log(
                    'info',
                    `[Publisher] Pending events done. Batches: ${batchNumber}, Success: ${totalSuccess}, Errors: ${totalErrors}, Time: ${elapsed}ms, Rate: ${actualRate}/s`
                );
            }
        } catch (error) {
            this.metrics?.increment('processingErrors');
            log('error', '[Publisher] Error during pending events processing', error);

            try {
                await this.disconnect();
            } catch {}

            throw error;
        } finally {
            this.pendingOperations--;
            this.isProcessingPending = false;
        }
    }

    public async disconnect(): Promise<void> {
        if (!this.connected) {
            return;
        }

        if (this.idleTimer) {
            clearTimeout(this.idleTimer);
            this.idleTimer = undefined;
        }

        await this.queue.disconnect();
        this.connected = false;
    }

    public stopPendingEventsCheck(): void {
        if (this.pendingEventsInterval) {
            clearInterval(this.pendingEventsInterval);
            this.pendingEventsInterval = undefined;
        }
    }

    public isConnected(): boolean {
        return this.connected;
    }

    private async connect(): Promise<void> {
        if (this.connected && !this.queue.closed) {
            return;
        }

        if (this.connectPromise) {
            await this.connectPromise;
            return;
        }

        this.connectPromise = (async () => {
            await this.queue.connect();
            this.connected = true;
            this.lastPublishTime = Date.now();
            this.startIdleMonitoring();
        })();

        try {
            await this.connectPromise;
        } finally {
            this.connectPromise = undefined;
        }
    }

    private startIdleMonitoring(): void {
        const idleTimeout = this.config.idleTimeoutMs ?? 10000;

        if (idleTimeout <= 0) {
            return;
        }

        if (this.idleTimer) {
            clearTimeout(this.idleTimer);
        }

        this.idleTimer = setTimeout(async () => {
            const idleTime = Date.now() - this.lastPublishTime;

            if (idleTime >= idleTimeout && this.connected && this.pendingOperations === 0) {
                try {
                    await this.disconnect();
                } catch (error) {
                    log('error', '[Publisher] Error during idle disconnect', error);
                }
            } else if (this.connected) {
                this.startIdleMonitoring();
            }
        }, idleTimeout);
    }

    private resetIdleTimer(): void {
        this.lastPublishTime = Date.now();
        const idleTimeout = this.config.idleTimeoutMs ?? 10000;

        if (idleTimeout > 0) {
            this.startIdleMonitoring();
        }
    }

    private startPendingEventsCheck(): void {
        this.pendingEventsInterval = setInterval(() => {
            if (this.isProcessingPending) {
                return;
            }

            this.processPendingEvents().catch(error =>
                log('error', '[Publisher] Error during periodic pending events check', error)
            );
        }, this.config.pendingEventsCheckIntervalMs);
    }

    private async publishToBroker(event: EventMessage): Promise<void> {
        const destination = this.config.queue ?? this.config.exchange!.name;

        await this.connect();
        this.resetIdleTimer();

        try {
            await this.queue.publish(destination, event, { exchange: this.config.exchange });
            this.resetIdleTimer();
        } catch (error) {
            if (!this.isRecoverableChannelError(error)) {
                throw error;
            }

            await this.recoverBrokerConnection();
            await this.queue.publish(destination, event, { exchange: this.config.exchange });
            this.resetIdleTimer();
        }
    }

    private async recoverBrokerConnection(): Promise<void> {
        if (this.reconnectPromise) {
            await this.reconnectPromise;
            return;
        }

        this.reconnectPromise = (async () => {
            this.connected = false;

            try {
                await this.queue.disconnect();
            } catch {}

            await this.connect();
            this.resetIdleTimer();
        })();

        try {
            await this.reconnectPromise;
        } finally {
            this.reconnectPromise = undefined;
        }
    }

    private isRecoverableChannelError(error: unknown): boolean {
        if (!(error instanceof Error)) {
            return false;
        }

        const stackAtStateChange =
            typeof (error as Error & { stackAtStateChange?: unknown }).stackAtStateChange === 'string'
                ? (error as Error & { stackAtStateChange: string }).stackAtStateChange
                : '';

        const text = `${error.name} ${error.message} ${stackAtStateChange}`.toLowerCase();

        return (
            text.includes('illegaloperationerror') ||
            text.includes('channel closed') ||
            text.includes('channel ended') ||
            text.includes('connection closed') ||
            text.includes('channelcloseok')
        );
    }

    private async checkStoreConnection(): Promise<void> {
        if (!this.config.store) {
            this.storeConnected = false;
            return;
        }

        const maxRetries = this.config.storeConnectionRetries ?? 3;
        const retryDelay = this.config.storeConnectionRetryDelayMs ?? 1000;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                await this.config.store.getEvent({
                    messageId: 'bb6c36b7-fa5a-4bf3-82b1-9cd7815f6c26',
                    type: '__health_check__',
                    payload: {}
                });

                this.storeConnected = true;
                return;
            } catch {
                if (attempt === maxRetries) {
                    this.storeConnected = false;
                    throw new Error(`Failed to connect to store after ${maxRetries} attempts`);
                }

                await this.sleep(retryDelay);
            }
        }
    }

    private validateConfig(): void {
        const instantPublish = this.config.instantPublish !== false;

        this.assertPositiveInteger('maxConcurrentPublishes', this.maxConcurrentPublishes);

        if (this.config.pendingEventsBatchSize !== undefined) {
            this.assertPositiveInteger('pendingEventsBatchSize', this.config.pendingEventsBatchSize);
        }

        if (!instantPublish && !this.config.store) {
            throw new Error('[Publisher] Configuration error: "store" is REQUIRED when "instantPublish" is set to false');
        }

        if (!instantPublish && this.config.store && !this.config.store.getPendingEvents) {
            throw new Error('[Publisher] Configuration error: store must implement "getPendingEvents()" method when "instantPublish" is set to false');
        }

        if (instantPublish && this.config.pendingEventsCheckIntervalMs) {
            log('warn', '[Publisher] Configuration warning: "pendingEventsCheckIntervalMs" has no effect when "instantPublish" is true');
        }

        if (!this.config.queue && !this.config.exchange) {
            throw new Error('[Publisher] Configuration error: either "queue" or "exchange" must be configured');
        }
    }

    private handleStoreInitFailure(): void {
        throw new Error('Failed to initialize publisher: store connection failed');
    }

    private assertPositiveInteger(name: string, value: number): void {
        if (!Number.isInteger(value) || value <= 0) {
            throw new Error(`[Publisher] Configuration error: "${name}" must be a positive integer`);
        }
    }

    private async sleep(ms: number): Promise<void> {
        await new Promise(resolve => setTimeout(resolve, ms));
    }
}