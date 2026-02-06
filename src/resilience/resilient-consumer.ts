import { ResilientEventConsumeProcessor } from "./resilient-event-consume-processor";
import { AmqpQueue } from "../broker/amqp-queue";
import { log } from "../logger/logger";
import { EventMessage, RabbitMQResilientProcessorConfig, ResilientConsumerConfig } from "../types";


export class ResilientConsumer {
    private processor!: ResilientEventConsumeProcessor;
    private queue!: AmqpQueue;
    private uptimeTimer?: ReturnType<typeof setTimeout>;
    private heartbeatTimer?: ReturnType<typeof setInterval>;
    private idleMonitorTimer?: ReturnType<typeof setInterval>;
    private reconnecting = false;
    private processingCount = 0;
    private storeConnected: boolean = false;

    constructor(private readonly config: ResilientConsumerConfig) {
        this.validateConfig();
    }

    /**
     * Validates the configuration.
     * @private
     */
    private validateConfig(): void {
        if (!this.config.consumeQueue?.queue) {
            throw new Error('[Consumer] Configuration error: "consumeQueue.queue" is required');
        }

        if (!this.config.eventsToProcess || this.config.eventsToProcess.length === 0) {
            throw new Error('[Consumer] Configuration error: "eventsToProcess" must have at least one event handler');
        }
    }

    /**
     * Checks the store connection with retry logic.
     * @private
     */
    private async checkStoreConnection(): Promise<void> {
        if (!this.config.store) {
            this.storeConnected = false;
            return;
        }

        const maxRetries = this.config.storeConnectionRetries ?? 3;
        const retryDelay = this.config.storeConnectionRetryDelayMs ?? 1000;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                log('debug', `[Consumer] Checking store connection (attempt ${attempt}/${maxRetries})...`);

                // Intentar una operación simple para verificar la conexión
                const testEvent: EventMessage = {
                    messageId: '8f747bb4-ca0a-4ef7-b479-d9183db942eb',
                    type: '__health_check__',
                    payload: {}
                };

                await this.config.store.getEvent(testEvent);

                this.storeConnected = true;
                log('info', '[Consumer] Store connection established');
                return;
            } catch (error) {
                log('debug', `[Consumer] Store connection attempt ${attempt}/${maxRetries} failed`, error);

                if (attempt === maxRetries) {
                    this.storeConnected = false;
                    throw new Error(`Failed to connect to store after ${maxRetries} attempts`);
                }

                // Esperar antes del siguiente intento
                await new Promise(resolve => setTimeout(resolve, retryDelay));
            }
        }
    }

    /**
     * Starts the resilient consumer.
     */
    public async start(): Promise<void> {
        // Verificar conexión al store si está configurado
        if (this.config.store) {
            try {
                await this.checkStoreConnection();
            } catch (error) {
                log('error', '[Consumer] Failed to connect to store during initialization', error);
                throw new Error('Failed to initialize consumer: store connection failed');
            }
        }

        await this.setupAndConsume();
    }

    private async setupAndConsume(): Promise<void> {
        log('debug', '[Consumer] Starting setup...');

        this.queue = new AmqpQueue(this.config.connection);
        log('debug', '[Consumer] Connecting to RabbitMQ...');
        await this.queue.connect(this.config.prefetch ?? 1);
        log('info', `[Consumer] Connected to RabbitMQ (prefetch: ${this.config.prefetch ?? 1})`);

        const { queue: consumeQueue, options, exchanges } = this.config.consumeQueue;
        log('debug', `[Consumer] Setting up consume queue: ${consumeQueue}`);

        // Setup DLQ first if configured
        let dlqExchangeName = '';
        if (this.config.deadLetterQueue) {
            const { queue: dlqName, exchange: dlqExchange, options: dlqOptions } = this.config.deadLetterQueue;
            log('debug', `[Consumer] Setting up dead letter queue: ${dlqName}`);

            if (dlqExchange) {
                dlqExchangeName = dlqExchange.name;
                log('debug', `[Consumer] Asserting DLQ exchange: ${dlqExchange.name}`);
                await this.queue.channel.assertExchange(dlqExchange.name, dlqExchange.type, dlqExchange.options);
            }

            await this.queue.channel.assertQueue(dlqName, dlqOptions);

            if (dlqExchange) {
                await this.queue.channel.bindQueue(dlqName, dlqExchange.name, dlqExchange.routingKey ?? "");
            }
        }

        // Setup retry queue if configured
        let retryExchangeName = '';
        if (this.config.retryQueue) {
            const { queue: retryQueueName, exchange: retryExchange, options: retryOptions } = this.config.retryQueue;
            const ttl = this.config.retryQueue.ttlMs ?? 5000;
            const maxAttempts = this.config.retryQueue.maxAttempts ?? 3;

            log('debug', `[Consumer] Setting up retry queue: ${retryQueueName} (TTL: ${ttl}ms, max attempts: ${maxAttempts})`);

            // Determine where retry queue should send messages after TTL
            let retryDlxExchange = '';
            let retryDlxRoutingKey = '';

            if (exchanges?.length) {
                // With exchanges: send back to main exchange
                const mainExchange = exchanges.find((e: any) => e.routingKey) || exchanges[0];
                retryDlxExchange = mainExchange.name;
                retryDlxRoutingKey = mainExchange.routingKey ?? "";
            } else {
                // Without exchanges: send directly back to main queue
                retryDlxExchange = "";
                retryDlxRoutingKey = consumeQueue;
            }

            // Create retry exchange if specified
            if (retryExchange) {
                retryExchangeName = retryExchange.name;
                log('debug', `[Consumer] Asserting retry exchange: ${retryExchange.name}`);
                await this.queue.channel.assertExchange(retryExchange.name, retryExchange.type, retryExchange.options);
            }

            // Create retry queue with DLX back to main queue
            await this.queue.channel.assertQueue(retryQueueName, {
                ...retryOptions,
                arguments: {
                    ...retryOptions?.arguments,
                    "x-dead-letter-exchange": retryDlxExchange,
                    "x-dead-letter-routing-key": retryDlxRoutingKey,
                    "x-message-ttl": ttl
                }
            });

            // Bind retry queue to retry exchange if specified
            if (retryExchange) {
                await this.queue.channel.bindQueue(retryQueueName, retryExchange.name, retryExchange.routingKey ?? "");
            }
        }

        // Setup main queue with DLX to retry or DLQ
        const mainQueueArgs: any = { ...options?.arguments };

        if (this.config.retryQueue) {
            // Main queue sends failed messages to retry queue
            if (retryExchangeName) {
                mainQueueArgs["x-dead-letter-exchange"] = retryExchangeName;
                mainQueueArgs["x-dead-letter-routing-key"] = this.config.retryQueue.exchange?.routingKey ?? "";
            } else {
                // Direct to retry queue without exchange
                mainQueueArgs["x-dead-letter-exchange"] = "";
                mainQueueArgs["x-dead-letter-routing-key"] = this.config.retryQueue.queue;
            }
        } else if (this.config.deadLetterQueue && dlqExchangeName) {
            // No retry, send directly to DLQ
            mainQueueArgs["x-dead-letter-exchange"] = dlqExchangeName;
            mainQueueArgs["x-dead-letter-routing-key"] = this.config.deadLetterQueue.exchange?.routingKey ?? "";
        }

        if (exchanges?.length) {
            log('debug', `[Consumer] Configuring ${exchanges.length} exchange(s) for queue binding`);

            for (const additionalExchange of exchanges) {
                log('debug', `[Consumer] Asserting exchange: ${additionalExchange.name} (type: ${additionalExchange.type})`);
                await this.queue.channel.assertExchange(additionalExchange.name, additionalExchange.type, additionalExchange.options);
            }

            log('debug', `[Consumer] Asserting main queue ${consumeQueue} with DLX configuration`);
            await this.queue.channel.assertQueue(consumeQueue, {
                ...options,
                arguments: mainQueueArgs
            });

            log('debug', `[Consumer] Binding consume queue to ${exchanges.length} exchange(s)...`);
            for (const additionalExchange of exchanges) {
                await this.queue.channel.bindQueue(consumeQueue, additionalExchange.name, additionalExchange.routingKey ?? "");
                log('debug', `[Consumer] Queue ${consumeQueue} bound to exchange ${additionalExchange.name}${additionalExchange.routingKey ? ` (routing key: ${additionalExchange.routingKey})` : ''}`);
            }
        } else {
            log('debug', `[Consumer] Asserting queue ${consumeQueue} with DLX configuration`);
            await this.queue.channel.assertQueue(consumeQueue, {
                ...options,
                arguments: mainQueueArgs
            });
        }

        // Verificar store antes de crear el processor
        if (this.config.store && !this.storeConnected) {
            log('debug', '[Consumer] Store configured but not connected, attempting reconnection...');
            await this.checkStoreConnection();
        }

        log('debug', '[Consumer] Initializing event processor...');
        this.processor = new ResilientEventConsumeProcessor({
            ...this.config,
            broker: this.queue
        } as RabbitMQResilientProcessorConfig);

        log('debug', `[Consumer] Starting to consume messages from queue: ${consumeQueue}`);
        await this.queue.consume(consumeQueue, async (event: EventMessage) => {
            this.processingCount++;
            log('info', `[Consumer] Received message ${event.messageId} (type: ${event.type})`);

            try {
                // Verificar store antes de procesar si está configurado
                if (this.config.store && !this.storeConnected) {
                    log('debug', '[Consumer] Store connection lost, attempting to reconnect...');
                    await this.checkStoreConnection();
                }

                await this.processor.process(event);
            } catch (error) {
                log('error', `[Consumer] Error processing message ${event.messageId}`, error);
                // Error is re-thrown to trigger nack in AMQP layer
                throw error;
            } finally {
                this.processingCount--;
            }
        });
        log('info', `[Consumer] Started consuming from queue: ${consumeQueue}`);

        this.scheduleReconnection();
        this.startHeartbeat();
        await this.startIdleMonitor();
    }

    private scheduleReconnection(): void {
        const maxUptime = this.config.maxUptimeMs ?? 0;
        if (maxUptime > 0) {
            log('debug', `[Consumer] Auto-reconnection scheduled after ${maxUptime}ms`);
            this.uptimeTimer = setTimeout(async () => {
                log("warn", `[Consumer] Max uptime reached, reconnecting...`);
                await this.reconnect();
            }, maxUptime);
        } else {
            log('debug', '[Consumer] Auto-reconnection disabled');
        }
    }

    private startHeartbeat(): void {
        const interval = this.config.heartbeatIntervalMs ?? 30000;
        log('debug', `[Consumer] Heartbeat monitor enabled (interval: ${interval}ms)`);

        this.heartbeatTimer = setInterval(async () => {
            try {
                log('debug', `[Consumer] Heartbeat check...`);
                await this.queue.channel.checkQueue(this.config.consumeQueue.queue);
                log('debug', '[Consumer] Heartbeat OK');
            } catch (error) {
                log("error", `[Consumer] Heartbeat failed`, error);
                log("warn", `[Consumer] Reconnecting due to failed heartbeat...`);
                await this.reconnect();
            }
        }, interval);
    }

    private async startIdleMonitor(): Promise<void> {
        if (!this.config.exitIfIdle) {
            log('debug', '[Consumer] Idle monitor disabled');
            return;
        }

        const checkInterval = this.config.idleCheckIntervalMs ?? 10000;
        const maxIdle = this.config.maxIdleChecks ?? 3;
        let idleCount = 0;

        log('info', `[Consumer] Idle monitor enabled (max idle checks: ${maxIdle}, interval: ${checkInterval}ms)`);

        const checkQueues = async () => {
            if (this.reconnecting) {
                log('debug', '[IdleMonitor] Skipping check - reconnection in progress');
                return;
            }

            try {
                log('debug', '[IdleMonitor] Checking queue message counts and processing status...');
                let totalMessages = 0;

                const main = await this.queue.channel.checkQueue(this.config.consumeQueue.queue);
                totalMessages += main.messageCount;
                log('debug', `[IdleMonitor] Main queue: ${main.messageCount} messages`);

                if (this.config.retryQueue?.queue) {
                    const retry = await this.queue.channel.checkQueue(this.config.retryQueue.queue);
                    totalMessages += retry.messageCount;
                    log('debug', `[IdleMonitor] Retry queue: ${retry.messageCount} messages`);
                }

                // Also consider messages currently being processed
                const totalPending = totalMessages + this.processingCount;
                log('debug', `[IdleMonitor] Total pending (queue + processing): ${totalPending} (${totalMessages} in queue, ${this.processingCount} processing)`);

                if (totalPending === 0) {
                    idleCount++;
                    log("debug", `[IdleMonitor] No messages found (idle count: ${idleCount}/${maxIdle})`);
                } else {
                    if (idleCount > 0) {
                        log('debug', `[IdleMonitor] Messages found, resetting idle count`);
                    }
                    idleCount = 0;
                }

                if (idleCount >= maxIdle) {
                    log("warn", `[IdleMonitor] Max idle checks reached, stopping consumer...`);
                    await this.stop();
                }
            } catch (error) {
                log("error", `[IdleMonitor] Error during idle check`, error);
            }
        };

        this.idleMonitorTimer = setInterval(checkQueues, checkInterval);
    }

    private async waitForProcessing(): Promise<void> {
        if (this.processingCount === 0) {
            log('debug', '[Consumer] No messages currently being processed');
            return;
        }

        log('info', `[Consumer] Waiting for ${this.processingCount} message(s) to finish...`);
        while (this.processingCount > 0) {
            await new Promise(res => setTimeout(res, 100));
        }
        log('debug', '[Consumer] All messages processed');
    }

    private async reconnect(): Promise<void> {
        if (this.reconnecting) {
            log('debug', '[Consumer] Reconnection already in progress');
            return;
        }

        log('warn', '[Consumer] Reconnecting...');
        this.reconnecting = true;

        await this.waitForProcessing();

        try {
            log('debug', '[Consumer] Cleaning up...');
            this.stopTimers();

            log('debug', '[Consumer] Cancelling consumers...');
            await this.queue.cancelAllConsumers();

            log('debug', '[Consumer] Closing channel...');
            await this.queue.channel.close();

            const socket = (this.queue.connection as any)?.connection?.stream;
            if (socket?.writable) {
                log('debug', '[Consumer] Closing connection...');
                await this.queue.connection.close();
            }
        } catch (err) {
            log("error", `[Consumer] Error during cleanup`, err);
        }

        const delay = this.config.reconnectDelayMs ?? 10000;
        log('info', `[Consumer] Restarting in ${delay}ms...`);

        setTimeout(() => {
            this.reconnecting = false;
            this.start().catch((error) => {
                log('error', '[Consumer] Failed to restart', error);
            });
        }, delay);
    }

    private stopTimers(): void {
        if (this.uptimeTimer) {
            log('debug', '[Consumer] Clearing uptime timer');
            clearTimeout(this.uptimeTimer);
            this.uptimeTimer = undefined;
        }
        if (this.heartbeatTimer) {
            log('debug', '[Consumer] Clearing heartbeat timer');
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = undefined;
        }
        if (this.idleMonitorTimer) {
            log('debug', '[Consumer] Clearing idle monitor timer');
            clearInterval(this.idleMonitorTimer);
            this.idleMonitorTimer = undefined;
        }
    }

    /**
     * Stops the consumer gracefully.
     * Waits for all messages to be processed, then closes connections.
     */
    public async stop(): Promise<void> {
        log('info', '[Consumer] Stopping consumer...');

        await this.waitForProcessing();

        this.stopTimers();

        try {
            if (this.queue && !this.queue.closed) {
                await this.queue.cancelAllConsumers();
                await this.queue.disconnect();
            }
        } catch (error) {
            log('error', '[Consumer] Error during stop', error);
        }

        log('info', '[Consumer] Consumer stopped');
    }
}
