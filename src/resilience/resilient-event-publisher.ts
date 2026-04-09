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
    private readonly connectionPool: AmqpQueue[];
    private currentConnectionIndex = 0;
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
    private readonly maxConnections: number;
    private readonly metrics?: MetricsCollector;

    public getMetrics(): ResilientMQMetrics | undefined {
        return this.metrics?.getSnapshot();
    }

    constructor(private readonly config: ResilientPublisherConfig) {
        this.maxConcurrentPublishes = config.maxConcurrentPublishes ?? 100;
        this.maxConnections = config.maxConnections ?? 1;
        this.validateConfig();
        this.instantPublish = config.instantPublish !== false;
        
        // Initialize connection pool
        this.connectionPool = [];
        for (let i = 0; i < this.maxConnections; i++) {
            this.connectionPool.push(new AmqpQueue(this.config.connection));
        }

        if (config.metricsEnabled) {
            this.metrics = new MetricsCollector();
        }

        const store = this.config.store;
        if (store) {
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
        const metrics = this.metrics;
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

                metrics?.increment('messagesPublished');
                log('info', `[Publisher] Published ${event.messageId}`);
            } else {
                log('debug', `[Publisher] Stored ${event.messageId} for later delivery`);
            }
        } catch (error) {
            metrics?.increment('processingErrors');
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
        const store = this.config.store;
        if (!store) {
            log('warn', '[Publisher] Cannot process pending events: no store configured');
            return;
        }

        if (!store.getPendingEvents) {
            throw new Error('Store must implement getPendingEvents() method');
        }

        if (this.isProcessingPending) {
            log('debug', '[Publisher] Pending events processing already in progress, skipping');
            return;
        }

        const {
            batchSize,
            maxPublishesPerSecond,
            maxConcurrentPublishes
        } = this.resolvePendingProcessingOptions(options);

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

                const rawResult = await store.getPendingEvents(EventPublishStatus.PENDING, batchSize);
                const pendingEvents: EventMessage[] = Array.isArray(rawResult)
                    ? rawResult
                    : Array.from(rawResult as Iterable<EventMessage>);

                if (!pendingEvents.length) {
                    break;
                }

                // Process events with rate limiting
                await this.processEventsWithRateLimit(
                    pendingEvents,
                    maxPublishesPerSecond,
                    maxConcurrentPublishes,
                    (success, errors) => {
                        totalSuccess += success;
                        totalErrors += errors;
                    }
                );

                if (pendingEvents.length < batchSize) {
                    break;
                }
            }

            const elapsed = Date.now() - startTime;
            const actualRate = elapsed > 0 ? Math.round((totalSuccess / elapsed) * 1000) : 0;

            if (totalSuccess > 0 || totalErrors > 0) {
                log(
                    'info',
                    `[Publisher] Pending events done. Batches: ${batchNumber}, Success: ${totalSuccess}, Errors: ${totalErrors}, Time: ${elapsed}ms, Actual rate: ${actualRate}/s, Target rate: ${maxPublishesPerSecond}/s, Concurrency: ${maxConcurrentPublishes}`
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

        // Disconnect all connections in the pool
        await Promise.all(
            this.connectionPool.map(queue => queue.disconnect())
        );
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

    /**
     * Get the next connection from the pool using round-robin strategy
     */
    private getNextConnection(): AmqpQueue {
        const connection = this.connectionPool[this.currentConnectionIndex];
        this.currentConnectionIndex = (this.currentConnectionIndex + 1) % this.maxConnections;
        return connection;
    }

    private async connect(): Promise<void> {
        const pool = this.connectionPool;
        if (this.connected && !pool.some(q => q.closed)) {
            return;
        }

        if (this.connectPromise) {
            await this.connectPromise;
            return;
        }

        this.connectPromise = (async () => {
            // Connect all connections in the pool
            await Promise.all(
                pool.map(queue => queue.connect())
            );
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
        const intervalMs = this.config.pendingEventsCheckIntervalMs;
        this.pendingEventsInterval = setInterval(() => {
            if (this.isProcessingPending) {
                return;
            }

            this.processPendingEvents().catch(error =>
                log('error', '[Publisher] Error during periodic pending events check', error)
            );
        }, intervalMs);
    }

    private async publishToBroker(event: EventMessage): Promise<void> {
        const { queue: configuredQueue, exchange } = this.config;
        const destination = configuredQueue ?? exchange!.name;

        await this.connect();
        this.resetIdleTimer();

        // Get next connection from pool (round-robin)
        const brokerConnection = this.getNextConnection();
        const publishOptions = { exchange };

        try {
            await brokerConnection.publish(destination, event, publishOptions);
            this.resetIdleTimer();
        } catch (error) {
            if (!this.isRecoverableChannelError(error)) {
                throw error;
            }

            await this.recoverBrokerConnection(brokerConnection);
            await brokerConnection.publish(destination, event, publishOptions);
            this.resetIdleTimer();
        }
    }

    private async recoverBrokerConnection(queue: AmqpQueue): Promise<void> {
        if (this.reconnectPromise) {
            await this.reconnectPromise;
            return;
        }

        this.reconnectPromise = (async () => {
            try {
                await queue.disconnect();
            } catch {}

            await queue.connect();
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
        this.assertPositiveInteger('maxConnections', this.maxConnections);

        if (this.config.pendingEventsBatchSize !== undefined) {
            this.assertPositiveInteger('pendingEventsBatchSize', this.config.pendingEventsBatchSize);
        }

        if (this.config.pendingEventsMaxPublishesPerSecond !== undefined) {
            this.assertPositiveInteger(
                'pendingEventsMaxPublishesPerSecond',
                this.config.pendingEventsMaxPublishesPerSecond
            );
        }

        if (this.config.pendingEventsMaxConcurrentPublishes !== undefined) {
            this.assertPositiveInteger(
                'pendingEventsMaxConcurrentPublishes',
                this.config.pendingEventsMaxConcurrentPublishes
            );
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

    private resolvePendingProcessingOptions(options: ProcessPendingEventsOptions) {
        const requestedBatchSize = options.batchSize ?? this.config.pendingEventsBatchSize ?? 100;
        const maxPublishesPerSecond =
            options.maxPublishesPerSecond ??
            this.config.pendingEventsMaxPublishesPerSecond ??
            requestedBatchSize;
        const requestedMaxConcurrentPublishes =
            options.maxConcurrentPublishes ??
            this.config.pendingEventsMaxConcurrentPublishes ??
            Math.min(10, maxPublishesPerSecond);

        this.assertPositiveInteger('batchSize', requestedBatchSize);
        this.assertPositiveInteger('maxPublishesPerSecond', maxPublishesPerSecond);
        this.assertPositiveInteger('maxConcurrentPublishes', requestedMaxConcurrentPublishes);

        return {
            batchSize: Math.max(requestedBatchSize, maxPublishesPerSecond),
            maxPublishesPerSecond,
            maxConcurrentPublishes: Math.min(requestedMaxConcurrentPublishes, maxPublishesPerSecond)
        };
    }

    /**
     * Processes events with rate limiting using a token bucket algorithm.
     * This ensures we respect maxPublishesPerSecond while maximizing throughput.
     */
    private async processEventsWithRateLimit(
        events: EventMessage[],
        maxPublishesPerSecond: number,
        maxConcurrentPublishes: number,
        onProgress: (success: number, errors: number) => void
    ): Promise<void> {
        if (!events.length) {
            return;
        }

        // Token bucket algorithm parameters
        const tokensPerSecond = maxPublishesPerSecond;
        const bucketSize = Math.max(maxPublishesPerSecond, maxConcurrentPublishes * 2);
        let tokens = bucketSize;
        let lastRefill = Date.now();

        // Tracking
        let successCount = 0;
        let errorCount = 0;
        let currentIndex = 0;
        const activePromises = new Set<Promise<void>>();

        // Batch status updates to reduce store overhead
        const statusUpdateQueue: Array<{ event: EventMessage; status: EventPublishStatus }> = [];
        const supportsBatchUpdate = this.config.store?.batchUpdateEventStatus !== undefined;

        const flushStatusUpdates = async () => {
            if (statusUpdateQueue.length === 0) return;

            const updates = [...statusUpdateQueue];
            statusUpdateQueue.length = 0;

            if (supportsBatchUpdate) {
                // Use batch update if available (much faster)
                try {
                    await this.config.store!.batchUpdateEventStatus!(updates);
                } catch (error) {
                    log('error', '[Publisher] Batch status update failed, falling back to individual updates', error);
                    // Fallback to individual updates
                    await Promise.all(
                        updates.map(({ event, status }) =>
                            this.config.store!.updateEventStatus(event, status).catch(() => {})
                        )
                    );
                }
            } else {
                // Process updates in parallel (legacy mode)
                await Promise.all(
                    updates.map(({ event, status }) =>
                        this.config.store!.updateEventStatus(event, status).catch(() => {})
                    )
                );
            }
        };

        // Flush updates periodically
        const flushInterval = setInterval(() => {
            flushStatusUpdates().catch(() => {});
        }, 100);

        // Refill tokens based on elapsed time
        const refillTokens = () => {
            const now = Date.now();
            const elapsed = (now - lastRefill) / 1000; // seconds
            const tokensToAdd = elapsed * tokensPerSecond;

            if (tokensToAdd >= 1) {
                tokens = Math.min(bucketSize, tokens + Math.floor(tokensToAdd));
                lastRefill = now;
            }
        };

        // Process a single event
        const processEvent = async (event: EventMessage) => {
            try {
                await this.publishToBroker(event);
                statusUpdateQueue.push({ event, status: EventPublishStatus.PUBLISHED });
                successCount++;
                this.metrics?.increment('messagesPublished');
            } catch (error) {
                errorCount++;
                this.metrics?.increment('processingErrors');
                log('error', `[Publisher] Failed to publish pending event ${event.messageId}`, error);
                statusUpdateQueue.push({ event, status: EventPublishStatus.ERROR });
            }
        };

        try {
            // Main processing loop
            while (currentIndex < events.length || activePromises.size > 0) {
                refillTokens();

                // Start new tasks if we have tokens and capacity
                while (
                    currentIndex < events.length &&
                    tokens >= 1 &&
                    activePromises.size < maxConcurrentPublishes
                ) {
                    tokens--;
                    const event = events[currentIndex++];

                    const promise = processEvent(event).finally(() => {
                        activePromises.delete(promise);
                    });

                    activePromises.add(promise);
                }

                // Wait for at least one task to complete or for tokens to refill
                if (activePromises.size > 0) {
                    if (currentIndex < events.length && tokens < 1) {
                        // Need to wait for tokens to refill
                        const waitTime = Math.min(100, 1000 / tokensPerSecond);
                        await Promise.race([
                            Promise.race(Array.from(activePromises)),
                            this.sleep(waitTime)
                        ]);
                    } else {
                        // Just wait for any task to complete
                        await Promise.race(Array.from(activePromises));
                    }
                } else if (currentIndex < events.length && tokens < 1) {
                    // No active tasks but need tokens
                    const waitTime = Math.min(100, 1000 / tokensPerSecond);
                    await this.sleep(waitTime);
                }
            }

            // Flush any remaining status updates
            await flushStatusUpdates();
        } finally {
            clearInterval(flushInterval);
            // Final flush to ensure all updates are persisted
            await flushStatusUpdates();
        }

        onProgress(successCount, errorCount);
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