import { ResilientEventConsumeProcessor } from './resilient-event-consume-processor';
import { AmqpQueue } from '../broker/amqp-queue';
import { log } from '../logger/logger';
import { EventMessage, RabbitMQResilientProcessorConfig, ResilientConsumerConfig } from '../types';
import { EventConsumeStatus } from '../types/enum/event-consume-status';
import { MetricsCollector, ResilientMQMetrics } from '../metrics/metrics-collector';

export class ResilientConsumer {
    private processor!: ResilientEventConsumeProcessor;
    private queue!: AmqpQueue;
    private uptimeTimer?: ReturnType<typeof setTimeout>;
    private heartbeatTimer?: ReturnType<typeof setInterval>;
    private idleMonitorTimer?: ReturnType<typeof setInterval>;
    private reconnecting = false;
    private storeConnected = false;
    private hasLoggedConsumeStart = false;
    private _processingCount = 0;
    private sigTermHandler?: () => void;
    private sigIntHandler?: () => void;
    private readonly metrics?: MetricsCollector;

    /** Number of event handlers currently executing. */
    get processingCount(): number { return this._processingCount; }

    /**
     * Returns a snapshot of current metrics. Only available when `metricsEnabled: true`.
     * Returns undefined if metrics are disabled.
     */
    public getMetrics(): ResilientMQMetrics | undefined {
        return this.metrics?.getSnapshot();
    }

    constructor(private readonly config: ResilientConsumerConfig) {
        this.validateConfig();
        if (config.metricsEnabled) {
            this.metrics = new MetricsCollector();
        }
    }

    // ─── Public API ────────────────────────────────────────────────────────────

    /** Starts the consumer. Registers SIGTERM/SIGINT handlers for graceful shutdown. */
    public async start(): Promise<void> {
        if (this.config.store) {
            try {
                await this.checkStoreConnection();
            } catch {
                throw new Error('Failed to initialize consumer: store connection failed');
            }
        }

        log('info', `[Consumer] Starting (prefetch: ${/* istanbul ignore next */ this.config.prefetch ?? 1})`);
        await this.setupAndConsume();

        this.sigTermHandler = () => this.stop();
        this.sigIntHandler = () => this.stop();
        process.once('SIGTERM', this.sigTermHandler);
        process.once('SIGINT', this.sigIntHandler);
    }

    /** Stops the consumer gracefully: waits for in-flight messages, reverts RETRY events, closes connections. */
    public async stop(): Promise<void> {
        log('info', '[Consumer] Stopping...');

        if (this.sigTermHandler) { process.removeListener('SIGTERM', this.sigTermHandler); this.sigTermHandler = undefined; }
        if (this.sigIntHandler) { process.removeListener('SIGINT', this.sigIntHandler); this.sigIntHandler = undefined; }

        await this.waitForProcessing();
        await this.revertRetryEvents();
        this.stopTimers();

        try {
            if (this.queue && !this.queue.closed) {
                await this.queue.cancelAllConsumers();
                await this.queue.disconnect();
            }
        } catch (error) {
            log('error', '[Consumer] Error during stop', error);
        }

        log('info', '[Consumer] Stopped');
    }

    // ─── Setup ─────────────────────────────────────────────────────────────────

    private async setupAndConsume(): Promise<void> {
        const { consumeQueue, prefetch, store } = this.config;
        const queueName = consumeQueue.queue;

        this.queue = new AmqpQueue(this.config.connection);
        await this.queue.connect(/* istanbul ignore next */ prefetch ?? 1);

        await this.setupQueuesAndExchanges();

        if (store && !this.storeConnected) {
            await this.checkStoreConnection();
        }

        this.processor = new ResilientEventConsumeProcessor({
            ...this.config,
            broker: this.queue,
        } as RabbitMQResilientProcessorConfig);

        await this.queue.consume(queueName, async (event: EventMessage) => {
            this._processingCount++;
            this.metrics?.increment('messagesReceived');
            const startedAt = this.metrics ? Date.now() : 0;
            try {
                if (store && !this.storeConnected) {
                    await this.checkStoreConnection();
                }
                await this.processor.process(event);
                this.metrics?.increment('messagesProcessed');
                if (this.metrics) {
                    this.metrics.recordProcessingTime(Date.now() - startedAt);
                }
            } catch (error) {
                /* istanbul ignore next */
                this.metrics?.increment('processingErrors');
                log('error', `[Consumer] Error processing message ${event.messageId}`, error);
                throw error;
            } finally {
                this._processingCount--;
            }
        });

        if (!this.hasLoggedConsumeStart) {
            log('info', `[Consumer] Consuming from: ${queueName}`);
            this.hasLoggedConsumeStart = true;
        }
        this.scheduleReconnection();
        this.startHeartbeat();
        await this.startIdleMonitor();
    }

    private async setupQueuesAndExchanges(): Promise<void> {
        const channel = this.queue.channel;
        const { queue: consumeQueue, options, exchanges } = this.config.consumeQueue;
        const deadLetterQueue = this.config.deadLetterQueue;
        const retryQueue = this.config.retryQueue;

        // Dead letter queue
        let dlqExchangeName = '';
        if (deadLetterQueue) {
            const { queue: dlqName, exchange: dlqExchange, options: dlqOptions } = deadLetterQueue;
            if (dlqExchange) {
                dlqExchangeName = dlqExchange.name;
                await channel.assertExchange(dlqExchange.name, dlqExchange.type, dlqExchange.options);
            }
            await channel.assertQueue(dlqName, dlqOptions);
            if (dlqExchange) {
                await channel.bindQueue(dlqName, dlqExchange.name, /* istanbul ignore next */ dlqExchange.routingKey ?? '');
            }
        }

        // Retry queue
        let retryExchangeName = '';
        if (retryQueue) {
            const { queue: retryQueueName, exchange: retryExchange, options: retryOptions } = retryQueue;
            const ttl = /* istanbul ignore next */ retryQueue.ttlMs ?? 5000;

            let retryDlxExchange = '';
            let retryDlxRoutingKey = '';
            if (exchanges?.length) {
                const mainExchange = exchanges.find((e: any) => e.routingKey) || /* istanbul ignore next */ exchanges[0];
                retryDlxExchange = mainExchange.name;
                retryDlxRoutingKey = /* istanbul ignore next */ mainExchange.routingKey ?? '';
            } else {
                retryDlxRoutingKey = consumeQueue;
            }

            if (retryExchange) {
                retryExchangeName = retryExchange.name;
                await channel.assertExchange(retryExchange.name, retryExchange.type, retryExchange.options);
            }

            await channel.assertQueue(retryQueueName, {
                ...retryOptions,
                arguments: {
                    /* istanbul ignore next */
                    ...retryOptions?.arguments,
                    'x-dead-letter-exchange': retryDlxExchange,
                    'x-dead-letter-routing-key': retryDlxRoutingKey,
                    'x-message-ttl': ttl,
                },
            });

            if (retryExchange) {
                await channel.bindQueue(retryQueueName, retryExchange.name, /* istanbul ignore next */ retryExchange.routingKey ?? '');
            }
        }

        // Main queue
        /* istanbul ignore next */
        const mainQueueArgs: any = { ...options?.arguments };
        if (retryQueue) {
            mainQueueArgs['x-dead-letter-exchange'] = retryExchangeName || '';
            mainQueueArgs['x-dead-letter-routing-key'] = retryExchangeName
                ? /* istanbul ignore next */ (retryQueue.exchange?.routingKey ?? '')
                : retryQueue.queue;
        } else if (deadLetterQueue && dlqExchangeName) {
            mainQueueArgs['x-dead-letter-exchange'] = dlqExchangeName;
            mainQueueArgs['x-dead-letter-routing-key'] = /* istanbul ignore next */ deadLetterQueue.exchange?.routingKey ?? '';
        }

        if (exchanges?.length) {
            for (const ex of exchanges) {
                await channel.assertExchange(ex.name, ex.type, ex.options);
            }
            await channel.assertQueue(consumeQueue, { ...options, arguments: mainQueueArgs });
            for (const ex of exchanges) {
                await channel.bindQueue(consumeQueue, ex.name, /* istanbul ignore next */ ex.routingKey ?? '');
            }
        } else {
            await channel.assertQueue(consumeQueue, { ...options, arguments: mainQueueArgs });
        }
    }

    // ─── Timers ────────────────────────────────────────────────────────────────

    private scheduleReconnection(): void {
        const maxUptime = this.config.maxUptimeMs ?? 0;
        if (maxUptime > 0) {
            this.uptimeTimer = setTimeout(() => this.reconnect(), maxUptime);
        }
    }

    private startHeartbeat(): void {
        const interval = /* istanbul ignore next */ this.config.heartbeatIntervalMs ?? 30000;
        const queueName = this.config.consumeQueue.queue;
        this.heartbeatTimer = setInterval(async () => {
            try {
                await this.queue.channel.checkQueue(queueName);
            } catch (error) {
                log('error', '[Consumer] Heartbeat failed', error);
                await this.reconnect();
            }
        }, interval);
    }

    private async startIdleMonitor(): Promise<void> {
        if (!this.config.exitIfIdle) return;

        /* istanbul ignore next */
        const checkInterval = this.config.idleCheckIntervalMs ?? 10000;
        /* istanbul ignore next */
        const maxIdle = this.config.maxIdleChecks ?? 3;
        const queueName = this.config.consumeQueue.queue;
        const retryQueueName = this.config.retryQueue?.queue;
        let idleCount = 0;

        this.idleMonitorTimer = setInterval(async () => {
            if (this.reconnecting) return;
            try {
                let totalMessages = 0;
                const main = await this.queue.channel.checkQueue(queueName);
                totalMessages += main.messageCount;

                if (retryQueueName) {
                    const retry = await this.queue.channel.checkQueue(retryQueueName);
                    totalMessages += retry.messageCount;
                }

                const total = totalMessages + /* istanbul ignore next */ (this.queue?.processingMessages ?? 0);
                idleCount = total === 0 ? idleCount + 1 : /* istanbul ignore next */ 0;

                if (idleCount >= maxIdle) {
                    log('warn', '[Consumer] Max idle checks reached, stopping...');
                    await this.stop();
                }
            } catch (error) {
                log('error', '[Consumer] Idle check error', error);
            }
        }, checkInterval);
    }

    private stopTimers(): void {
        if (this.uptimeTimer) { clearTimeout(this.uptimeTimer); this.uptimeTimer = undefined; }
        if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = undefined; }
        if (this.idleMonitorTimer) { clearInterval(this.idleMonitorTimer); this.idleMonitorTimer = undefined; }
    }

    // ─── Reconnection ──────────────────────────────────────────────────────────

    private async reconnect(): Promise<void> {
        if (this.reconnecting) return;
        this.reconnecting = true;
        const queue = this.queue;

        await this.waitForProcessing();
        this.stopTimers();

        try {
            await queue.cancelAllConsumers();
            await queue.channel.close();
            /* istanbul ignore next */
            const socket = (queue.connection as any)?.connection?.stream;
            /* istanbul ignore next */
            if (socket?.writable) await queue.connection.close();
        } catch (err) {
            log('error', '[Consumer] Error during reconnect cleanup', err);
        }

        /* istanbul ignore next */
        const delay = this.config.reconnectDelayMs ?? 10000;
        setTimeout(() => {
            this.reconnecting = false;
            this.setupAndConsume().catch(err => log('error', '[Consumer] Failed to restart', err));
        }, delay);
    }

    // ─── Shutdown helpers ──────────────────────────────────────────────────────

    private async waitForProcessing(): Promise<void> {
        if (!this.queue || typeof this.queue.waitForProcessing !== 'function') return;
        await this.queue.waitForProcessing();
    }

    private async revertRetryEvents(): Promise<void> {
        if (!this.config.store || typeof this.config.store.getEventsByStatus !== 'function') return;
        try {
            const retryEvents = await this.config.store.getEventsByStatus!(EventConsumeStatus.RETRY);
            for (const event of retryEvents) {
                await this.config.store.updateEventStatus(event, EventConsumeStatus.ERROR);
            }
            if (retryEvents.length > 0) {
                log('warn', `[Consumer] Reverted ${retryEvents.length} RETRY event(s) to ERROR on shutdown`);
            }
        } catch (error) {
            log('error', '[Consumer] Error reverting RETRY events', error);
        }
    }

    // ─── Store connection ──────────────────────────────────────────────────────

    private async checkStoreConnection(): Promise<void> {
        if (!this.config.store) { this.storeConnected = false; return; }

        /* istanbul ignore next */
        const maxRetries = this.config.storeConnectionRetries ?? 3;
        /* istanbul ignore next */
        const retryDelay = this.config.storeConnectionRetryDelayMs ?? 1000;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                await this.config.store.getEvent({ messageId: '8f747bb4-ca0a-4ef7-b479-d9183db942eb', type: '__health_check__', payload: {} });
                this.storeConnected = true;
                return;
            } catch {
                if (attempt === maxRetries) {
                    this.storeConnected = false;
                    throw new Error(`Failed to connect to store after ${maxRetries} attempts`);
                }
                await new Promise(resolve => setTimeout(resolve, retryDelay));
            }
        }
    }

    // ─── Validation ────────────────────────────────────────────────────────────

    private validateConfig(): void {
        /* istanbul ignore next */
        if (!this.config.consumeQueue?.queue) {
            throw new Error('[Consumer] Configuration error: "consumeQueue.queue" is required');
        }
        /* istanbul ignore next */
        if (!this.config.eventsToProcess?.length) {
            throw new Error('[Consumer] Configuration error: "eventsToProcess" must have at least one event handler');
        }
    }
}
