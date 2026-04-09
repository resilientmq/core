import { AmqpQueue } from '../broker/amqp-queue';
import { isLogLevelEnabled, log } from '../logger/logger';
import {
    EventMessage,
    EventPublishStatus,
    ProcessPendingEventsOptions,
    ResilientPublisherConfig
} from '../types';
import { MetricsCollector, ResilientMQMetrics } from '../metrics/metrics-collector';

export class ResilientEventPublisher {
    private readonly connectionPool: AmqpQueue[];
    private pendingConnectionPool?: AmqpQueue[];
    private currentConnectionIndex = 0;
    private pendingCurrentConnectionIndex = 0;
    private pendingEventsInterval?: NodeJS.Timeout;
    private idleTimer?: NodeJS.Timeout;
    private connectPromise?: Promise<void>;
    private pendingConnectPromise?: Promise<void>;
    private reconnectPromise?: Promise<void>;
    private pendingReconnectPromise?: Promise<void>;
    private storeReconnectInFlight?: Promise<void>;
    private lastStoreReconnectAttemptAt = 0;
    private readonly instantPublish: boolean;
    private storeConnected = false;
    private connected = false;
    private pendingConnected = false;
    private lastPublishTime = 0;
    private pendingOperations = 0;
    private isProcessingPending = false;
    private readonly maxConcurrentPublishes: number;
    private readonly maxConnections: number;
    private readonly pendingMaxConnections: number;
    private readonly separatePendingConnections: boolean;
    private readonly metrics?: MetricsCollector;
    private readonly publishDestination: string;
    private readonly publishOptions?: { exchange?: ResilientPublisherConfig['exchange'] };
    private readonly pendingSlotWaiters: Array<() => void> = [];
    private readonly pendingAdaptiveConcurrencyEnabled: boolean;
    private readonly pendingAdaptiveEwmaAlpha: number;
    private readonly pendingAdaptiveErrorThresholdSoft: number;
    private readonly pendingAdaptiveErrorThresholdHard: number;

    public getMetrics(): ResilientMQMetrics | undefined {
        return this.metrics?.getSnapshot();
    }

    constructor(private readonly config: ResilientPublisherConfig) {
        this.maxConcurrentPublishes = config.maxConcurrentPublishes ?? 100;
        this.maxConnections = config.maxConnections ?? 1;
        this.separatePendingConnections = config.separatePendingConnections !== false;
        this.pendingMaxConnections = config.pendingMaxConnections ?? this.maxConnections;
        this.pendingAdaptiveConcurrencyEnabled = config.pendingAdaptiveConcurrency !== false;
        this.pendingAdaptiveEwmaAlpha = config.pendingAdaptiveEwmaAlpha ?? 0.2;
        this.pendingAdaptiveErrorThresholdSoft = config.pendingAdaptiveErrorThresholdSoft ?? 0.08;
        this.pendingAdaptiveErrorThresholdHard = config.pendingAdaptiveErrorThresholdHard ?? 0.2;
        this.validateConfig();
        this.instantPublish = config.instantPublish !== false;
        this.publishDestination = this.config.queue ?? this.config.exchange!.name;
        this.publishOptions = this.config.exchange ? { exchange: this.config.exchange } : undefined;
        
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
        await this.acquirePendingSlot();

        try {
            const store = this.config.store;
            const shouldPublishNow = !options?.storeOnly && (this.instantPublish || !store);

            if (store) {
                if (!this.storeConnected) {
                    await this.ensureStoreConnection();
                }
                event.status = EventPublishStatus.PENDING;

                if (store.saveEventIfNotExists) {
                    const inserted = await store.saveEventIfNotExists(event);
                    if (!inserted) {
                        if (isLogLevelEnabled('warn')) {
                            log('warn', `[Publisher] Duplicate message: ${event.messageId}, skipping`);
                        }
                        return;
                    }
                } else {
                    const existing = await store.getEvent(event);
                    if (existing) {
                        if (isLogLevelEnabled('warn')) {
                            log('warn', `[Publisher] Duplicate message: ${event.messageId}, skipping`);
                        }
                        return;
                    }

                    await store.saveEvent(event);
                }
            } else {
                event.status = EventPublishStatus.PENDING;
            }

            if (shouldPublishNow) {
                await this.publishToBroker(event);

                if (store) {
                    await store.updateEventStatus(event, EventPublishStatus.PUBLISHED);
                }

                metrics?.increment('messagesPublished');
                if (isLogLevelEnabled('info')) {
                    log('info', `[Publisher] Published ${event.messageId}`);
                }
            } else {
                if (isLogLevelEnabled('debug')) {
                    log('debug', `[Publisher] Stored ${event.messageId} for later delivery`);
                }
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
            this.releasePendingSlot();
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
                await this.ensureStoreConnection();
            }

            await this.connect(true);
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
                if (isLogLevelEnabled('info')) {
                    log(
                        'info',
                        `[Publisher] Pending events done. Batches: ${batchNumber}, Success: ${totalSuccess}, Errors: ${totalErrors}, Time: ${elapsed}ms, Actual rate: ${actualRate}/s, Target rate: ${maxPublishesPerSecond}/s, Concurrency: ${maxConcurrentPublishes}`
                    );
                }
            }
        } catch (error) {
            this.metrics?.increment('processingErrors');
            log('error', '[Publisher] Error during pending events processing', error);

            try {
                await this.disconnect();
            } catch {}

            throw error;
        } finally {
            this.releasePendingSlot();
            this.isProcessingPending = false;
        }
    }

    public async disconnect(): Promise<void> {
        if (!this.connected && !this.pendingConnected) {
            return;
        }

        if (this.idleTimer) {
            clearTimeout(this.idleTimer);
            this.idleTimer = undefined;
        }

        const pools: AmqpQueue[][] = [this.connectionPool];
        if (this.pendingConnectionPool) {
            pools.push(this.pendingConnectionPool);
        }

        // Disconnect all connections in active pools
        await Promise.all(pools.flatMap(pool => pool.map(queue => queue.disconnect())));
        this.connected = false;
        this.pendingConnected = false;
    }

    public stopPendingEventsCheck(): void {
        if (this.pendingEventsInterval) {
            clearInterval(this.pendingEventsInterval);
            this.pendingEventsInterval = undefined;
        }
    }

    public isConnected(): boolean {
        return this.connected || this.pendingConnected;
    }

    /**
     * Get the next connection from the pool using round-robin strategy
     */
    private ensurePendingConnectionPool(): AmqpQueue[] {
        if (!this.pendingConnectionPool) {
            this.pendingConnectionPool = [];
            for (let i = 0; i < this.pendingMaxConnections; i++) {
                this.pendingConnectionPool.push(new AmqpQueue(this.config.connection));
            }
        }

        return this.pendingConnectionPool;
    }

    /**
     * Get next connection from either realtime or pending pool using round-robin.
     */
    private getNextConnection(usePendingPool: boolean): AmqpQueue {
        if (usePendingPool && this.separatePendingConnections) {
            const pool = this.ensurePendingConnectionPool();
            const connection = pool[this.pendingCurrentConnectionIndex];
            this.pendingCurrentConnectionIndex = (this.pendingCurrentConnectionIndex + 1) % pool.length;
            return connection;
        }

        const connection = this.connectionPool[this.currentConnectionIndex];
        this.currentConnectionIndex = (this.currentConnectionIndex + 1) % this.connectionPool.length;
        return connection;
    }

    private async connect(usePendingPool = false): Promise<void> {
        if (usePendingPool && this.separatePendingConnections) {
            const pool = this.ensurePendingConnectionPool();
            if (this.pendingConnected && !pool.some(q => q.closed)) {
                return;
            }

            if (this.pendingConnectPromise) {
                await this.pendingConnectPromise;
                return;
            }

            this.pendingConnectPromise = (async () => {
                await Promise.all(pool.map(queue => queue.connect()));
                this.pendingConnected = true;
                this.lastPublishTime = Date.now();
                this.startIdleMonitoring();
            })();

            try {
                await this.pendingConnectPromise;
            } finally {
                this.pendingConnectPromise = undefined;
            }
            return;
        }

        const pool = this.connectionPool;
        if (this.connected && !pool.some(q => q.closed)) {
            return;
        }

        if (this.connectPromise) {
            await this.connectPromise;
            return;
        }

        this.connectPromise = (async () => {
            await Promise.all(pool.map(queue => queue.connect()));
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

            const anyPoolConnected = this.connected || this.pendingConnected;

            if (idleTime >= idleTimeout && anyPoolConnected && this.pendingOperations === 0) {
                try {
                    await this.disconnect();
                } catch (error) {
                    log('error', '[Publisher] Error during idle disconnect', error);
                }
            } else if (anyPoolConnected) {
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

    private async publishToBroker(event: EventMessage, usePendingPool = false): Promise<void> {
        await this.connect(usePendingPool);
        this.resetIdleTimer();

        // Get next connection from pool (round-robin)
        const brokerConnection = this.getNextConnection(usePendingPool);

        try {
            await brokerConnection.publish(this.publishDestination, event, this.publishOptions);
        } catch (error) {
            if (!this.isRecoverableChannelError(error)) {
                throw error;
            }

            await this.recoverBrokerConnection(brokerConnection, usePendingPool);
            await brokerConnection.publish(this.publishDestination, event, this.publishOptions);
        }

        this.resetIdleTimer();
    }

    private async recoverBrokerConnection(queue: AmqpQueue, usePendingPool: boolean): Promise<void> {
        if (usePendingPool && this.separatePendingConnections) {
            if (this.pendingReconnectPromise) {
                await this.pendingReconnectPromise;
                return;
            }

            this.pendingReconnectPromise = (async () => {
                try {
                    await queue.disconnect();
                } catch {}

                await queue.connect();
                this.resetIdleTimer();
            })();

            try {
                await this.pendingReconnectPromise;
            } finally {
                this.pendingReconnectPromise = undefined;
            }
            return;
        }

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

    private async ensureStoreConnection(): Promise<void> {
        if (!this.config.store) {
            this.storeConnected = false;
            return;
        }

        if (this.storeConnected) {
            return;
        }

        if (this.storeReconnectInFlight) {
            await this.storeReconnectInFlight;
            return;
        }

        const now = Date.now();
        const minInterval = this.config.storeConnectionRetryDelayMs ?? 1000;
        const elapsed = now - this.lastStoreReconnectAttemptAt;
        if (elapsed < minInterval) {
            if (this.storeReconnectInFlight) {
                await this.storeReconnectInFlight;
            }
            // Throttle reconnect attempts without blocking the publish hot path.
            return;
        }

        this.lastStoreReconnectAttemptAt = now;
        this.storeReconnectInFlight = this.checkStoreConnection().finally(() => {
            this.storeReconnectInFlight = undefined;
        });

        await this.storeReconnectInFlight;
    }

    private validateConfig(): void {
        const instantPublish = this.config.instantPublish !== false;

        this.assertPositiveInteger('maxConcurrentPublishes', this.maxConcurrentPublishes);
        this.assertPositiveInteger('maxConnections', this.maxConnections);
        this.assertPositiveInteger('pendingMaxConnections', this.pendingMaxConnections);

        if (this.pendingAdaptiveEwmaAlpha <= 0 || this.pendingAdaptiveEwmaAlpha > 1) {
            throw new Error('[Publisher] Configuration error: "pendingAdaptiveEwmaAlpha" must be > 0 and <= 1');
        }

        if (
            this.pendingAdaptiveErrorThresholdSoft < 0 ||
            this.pendingAdaptiveErrorThresholdSoft > 1
        ) {
            throw new Error('[Publisher] Configuration error: "pendingAdaptiveErrorThresholdSoft" must be between 0 and 1');
        }

        if (
            this.pendingAdaptiveErrorThresholdHard < 0 ||
            this.pendingAdaptiveErrorThresholdHard > 1
        ) {
            throw new Error('[Publisher] Configuration error: "pendingAdaptiveErrorThresholdHard" must be between 0 and 1');
        }

        if (this.pendingAdaptiveErrorThresholdHard < this.pendingAdaptiveErrorThresholdSoft) {
            throw new Error('[Publisher] Configuration error: "pendingAdaptiveErrorThresholdHard" must be >= "pendingAdaptiveErrorThresholdSoft"');
        }

        if (
            this.config.pendingAdaptiveTargetLatencyMs !== undefined &&
            this.config.pendingAdaptiveTargetLatencyMs <= 0
        ) {
            throw new Error('[Publisher] Configuration error: "pendingAdaptiveTargetLatencyMs" must be > 0');
        }

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
        let currentConcurrencyLimit = maxConcurrentPublishes;
        const ewmaAlpha = this.pendingAdaptiveEwmaAlpha;
        const latencyTargetMs = this.config.pendingAdaptiveTargetLatencyMs ?? Math.max(5, Math.floor(1000 / Math.max(1, tokensPerSecond)));
        let ewmaLatencyMs = 0;
        let ewmaErrorRate = 0;
        let activeCompletionResolve: (() => void) | undefined;
        let nextActiveCompletion = new Promise<void>(resolve => {
            activeCompletionResolve = resolve;
        });

        // Batch status updates to reduce store overhead
        const statusUpdateQueue: Array<{ event: EventMessage; status: EventPublishStatus }> = [];
        const supportsBatchUpdate = this.config.store?.batchUpdateEventStatus !== undefined;
        const flushBatchThreshold = 64;
        const flushIntervalMs = 100;
        let lastFlushAt = Date.now();
        const canUseFullParallel =
            events.length <= maxConcurrentPublishes &&
            tokensPerSecond >= events.length;

        const flushStatusUpdates = async () => {
            if (statusUpdateQueue.length === 0) return;

            const updates = statusUpdateQueue.splice(0, statusUpdateQueue.length);

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

        const updateAdaptiveSignals = (latencyMs: number, failed: boolean) => {
            ewmaLatencyMs = ewmaLatencyMs === 0
                ? latencyMs
                : (ewmaLatencyMs * (1 - ewmaAlpha)) + (latencyMs * ewmaAlpha);

            const errorSample = failed ? 1 : 0;
            ewmaErrorRate = (ewmaErrorRate * (1 - ewmaAlpha)) + (errorSample * ewmaAlpha);
        };

        // Process a single event
        const processEvent = async (event: EventMessage) => {
            const startedAt = Date.now();
            let failed = false;
            try {
                await this.publishToBroker(event, true);
                statusUpdateQueue.push({ event, status: EventPublishStatus.PUBLISHED });
                successCount++;
                this.metrics?.increment('messagesPublished');
            } catch (error) {
                errorCount++;
                failed = true;
                this.metrics?.increment('processingErrors');
                log('error', `[Publisher] Failed to publish pending event ${event.messageId}`, error);
                statusUpdateQueue.push({ event, status: EventPublishStatus.ERROR });
            } finally {
                const latencyMs = Date.now() - startedAt;
                updateAdaptiveSignals(latencyMs, failed);
            }
        };

        const rebalanceConcurrency = () => {
            if (!this.pendingAdaptiveConcurrencyEnabled) {
                return;
            }

            if (ewmaErrorRate >= this.pendingAdaptiveErrorThresholdHard) {
                // Aggressive backoff when failures spike.
                currentConcurrencyLimit = Math.max(
                    1,
                    currentConcurrencyLimit - Math.max(1, Math.ceil(currentConcurrencyLimit * 0.25))
                );
                return;
            }

            if (ewmaErrorRate >= this.pendingAdaptiveErrorThresholdSoft || ewmaLatencyMs > (latencyTargetMs * 3)) {
                currentConcurrencyLimit = Math.max(1, currentConcurrencyLimit - 1);
                return;
            }

            if (ewmaErrorRate <= 0.02 && ewmaLatencyMs <= (latencyTargetMs * 1.25)) {
                currentConcurrencyLimit = Math.min(maxConcurrentPublishes, currentConcurrencyLimit + 1);
            }
        };

        const signalActiveCompletion = () => {
            const resolve = activeCompletionResolve;
            activeCompletionResolve = undefined;

            if (resolve) {
                resolve();
            }

            nextActiveCompletion = new Promise<void>(nextResolve => {
                activeCompletionResolve = nextResolve;
            });
        };

        const waitForActiveCompletion = async (waitForTokens: boolean) => {
            if (activePromises.size === 0) {
                return;
            }

            if (!waitForTokens) {
                await nextActiveCompletion;
                return;
            }

            const waitTime = Math.min(100, 1000 / tokensPerSecond);
            await Promise.race([
                nextActiveCompletion,
                this.sleep(waitTime)
            ]);
        };

        try {
            if (canUseFullParallel) {
                await Promise.all(events.map(event => processEvent(event)));
                await flushStatusUpdates();
                onProgress(successCount, errorCount);
                return;
            }

            // Main processing loop
            while (currentIndex < events.length || activePromises.size > 0) {
                refillTokens();

                // Start new tasks if we have tokens and capacity
                while (
                    currentIndex < events.length &&
                    tokens >= 1 &&
                    activePromises.size < currentConcurrencyLimit
                ) {
                    tokens--;
                    const event = events[currentIndex++];

                    const promise = processEvent(event).finally(() => {
                        activePromises.delete(promise);
                        signalActiveCompletion();
                    });

                    activePromises.add(promise);
                }

                // Wait for at least one task to complete or for tokens to refill
                if (activePromises.size > 0) {
                    if (currentIndex < events.length && tokens < 1) {
                        // Need to wait for tokens to refill
                        await waitForActiveCompletion(true);
                    } else {
                        // Just wait for any task to complete
                        await waitForActiveCompletion(false);
                    }
                } else if (currentIndex < events.length && tokens < 1) {
                    // No active tasks but need tokens
                    const waitTime = Math.min(100, 1000 / tokensPerSecond);
                    await this.sleep(waitTime);
                }

                const now = Date.now();
                if (
                    statusUpdateQueue.length > 0 &&
                    (statusUpdateQueue.length >= flushBatchThreshold || now - lastFlushAt >= flushIntervalMs)
                ) {
                    await flushStatusUpdates();
                    lastFlushAt = now;
                    rebalanceConcurrency();
                }
            }

            // Flush any remaining status updates
            await flushStatusUpdates();
        } finally {
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

    private async acquirePendingSlot(): Promise<void> {
        while (this.pendingOperations >= this.maxConcurrentPublishes) {
            await new Promise<void>(resolve => {
                let settled = false;

                const waiter = () => {
                    if (settled) {
                        return;
                    }

                    settled = true;
                    clearTimeout(timeoutId);
                    resolve();
                };

                const timeoutId = setTimeout(() => {
                    if (settled) {
                        return;
                    }

                    settled = true;
                    const idx = this.pendingSlotWaiters.indexOf(waiter);
                    if (idx >= 0) {
                        this.pendingSlotWaiters.splice(idx, 1);
                    }
                    resolve();
                }, 10);

                this.pendingSlotWaiters.push(waiter);
            });
        }

        this.pendingOperations++;
    }

    private releasePendingSlot(): void {
        this.pendingOperations = Math.max(0, this.pendingOperations - 1);

        const nextWaiter = this.pendingSlotWaiters.shift();
        if (nextWaiter) {
            nextWaiter();
        }
    }

    private async sleep(ms: number): Promise<void> {
        await new Promise(resolve => setTimeout(resolve, ms));
    }
}