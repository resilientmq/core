import { ResilientEventConsumeProcessor } from "./resilient-event-consume-processor";
import { AmqpQueue } from "../broker/amqp-queue";
import { log } from "../logger/logger";
import { EventMessage, RabbitMQResilientProcessorConfig, ResilientConsumerConfig } from "../types";

export class ResilientConsumer {
    private processor!: ResilientEventConsumeProcessor;
    private queue!: AmqpQueue;
    private uptimeTimer?: ReturnType<typeof setTimeout>;
    private heartbeatTimer?: ReturnType<typeof setInterval>;
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
                log('info', `[Consumer] Checking store connection (attempt ${attempt}/${maxRetries})...`);

                // Intentar una operación simple para verificar la conexión
                const testEvent: EventMessage = {
                    messageId: `__health_check_${Date.now()}__`,
                    type: '__health_check__',
                    payload: {},
                    status: undefined as any
                };

                await this.config.store.getEvent(testEvent);

                this.storeConnected = true;
                log('info', '[Consumer] Store connection established successfully');
                return;
            } catch (error) {
                log('warn', `[Consumer] Store connection attempt ${attempt}/${maxRetries} failed`, error);

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
        log('info', '[Consumer] Starting setup and consume process...');

        this.queue = new AmqpQueue(this.config.connection);
        log('info', '[Consumer] Connecting to RabbitMQ...');
        await this.queue.connect(this.config.prefetch ?? 1);
        log('info', `[Consumer] Connected to RabbitMQ with prefetch: ${this.config.prefetch ?? 1}`);

        const { queue: consumeQueue, options, exchanges } = this.config.consumeQueue;
        log('info', `[Consumer] Setting up consume queue: ${consumeQueue}`);

        if (exchanges?.length) {
            log('info', `[Consumer] Configuring ${exchanges.length} exchange(s) for queue binding`);

            for (const additionalExchange of exchanges) {
                log('info', `[Consumer] Asserting exchange: ${additionalExchange.name} (type: ${additionalExchange.type})`);
                await this.queue.channel.assertExchange(additionalExchange.name, additionalExchange.type, additionalExchange.options);
            }

            const restrictiveExchange = exchanges.find((e: any) => e.routingKey) || exchanges[0];
            log('info', `[Consumer] Using restrictive exchange: ${restrictiveExchange.name}`);

            if (this.config.retryQueue) {
                const { queue: retryQueueName, exchange: retryExchange, options: retryOptions } = this.config.retryQueue;
                log('info', `[Consumer] Setting up retry queue: ${retryQueueName} with TTL: ${this.config.retryQueue.ttlMs ?? 10000}ms`);

                await this.queue.channel.assertQueue(retryQueueName, {
                    ...retryOptions,
                    arguments: {
                        ...retryOptions?.arguments,
                        "x-dead-letter-exchange": restrictiveExchange.name,
                        "x-dead-letter-routing-key": restrictiveExchange.routingKey ?? "",
                        "x-message-ttl": this.config.retryQueue.ttlMs ?? 10000
                    }
                });
                log('info', `[Consumer] Retry queue ${retryQueueName} created successfully`);

                if (retryExchange) {
                    log('info', `[Consumer] Asserting retry exchange: ${retryExchange.name} (type: ${retryExchange.type})`);
                    await this.queue.channel.assertExchange(retryExchange.name, retryExchange.type, retryExchange.options);
                    await this.queue.channel.bindQueue(retryQueueName, retryExchange.name, retryExchange.routingKey ?? "");
                    log('info', `[Consumer] Retry queue bound to exchange ${retryExchange.name}`);
                }

                log('info', `[Consumer] Asserting main queue ${consumeQueue} with DLX to retry queue`);
                await this.queue.channel.assertQueue(consumeQueue, {
                    ...options,
                    arguments: {
                        ...options?.arguments,
                        "x-dead-letter-exchange": retryExchange?.name || "",
                        "x-dead-letter-routing-key": retryExchange?.routingKey ?? ""
                    }
                });
            } else {
                log('info', `[Consumer] Asserting main queue ${consumeQueue} without retry configuration`);
                await this.queue.channel.assertQueue(consumeQueue, options);
            }

            if (this.config.deadLetterQueue) {
                const { queue: dlqName, exchange: dlqExchange, options: dlqOptions } = this.config.deadLetterQueue;
                log('info', `[Consumer] Setting up dead letter queue: ${dlqName}`);
                await this.queue.channel.assertQueue(dlqName, dlqOptions);

                if (dlqExchange) {
                    log('info', `[Consumer] Asserting DLQ exchange: ${dlqExchange.name} (type: ${dlqExchange.type})`);
                    await this.queue.channel.assertExchange(dlqExchange.name, dlqExchange.type, dlqExchange.options);
                    await this.queue.channel.bindQueue(dlqName, dlqExchange.name, dlqExchange.routingKey ?? "");
                    log('info', `[Consumer] DLQ bound to exchange ${dlqExchange.name}`);
                }
            }

            log('info', `[Consumer] Binding consume queue to ${exchanges.length} exchange(s)...`);
            for (const additionalExchange of exchanges) {
                await this.queue.channel.bindQueue(consumeQueue, additionalExchange.name, additionalExchange.routingKey ?? "");
                log('info', `[Consumer] Queue ${consumeQueue} bound to exchange ${additionalExchange.name} with routing key: ${additionalExchange.routingKey ?? '(none)'}`);
            }
        } else {
            log('info', `[Consumer] Asserting queue ${consumeQueue} without exchange bindings`);
            await this.queue.channel.assertQueue(consumeQueue, options);
        }

        // Verificar store antes de crear el processor
        if (this.config.store && !this.storeConnected) {
            log('warn', '[Consumer] Store configured but not connected, attempting reconnection...');
            await this.checkStoreConnection();
        }

        log('info', '[Consumer] Initializing event processor...');
        this.processor = new ResilientEventConsumeProcessor({
            ...this.config,
            broker: this.queue
        } as RabbitMQResilientProcessorConfig);

        log('info', `[Consumer] Starting to consume messages from queue: ${consumeQueue}`);
        await this.queue.consume(consumeQueue, async (event: EventMessage) => {
            this.processingCount++;
            log('info', `[Consumer] Received message ${event.messageId} of type ${event.type} (processing count: ${this.processingCount})`);

            try {
                // Verificar store antes de procesar si está configurado
                if (this.config.store && !this.storeConnected) {
                    log('warn', '[Consumer] Store connection lost, attempting to reconnect before processing...');
                    await this.checkStoreConnection();
                }

                await this.processor.process(event);
                log('info', `[Consumer] Successfully processed message ${event.messageId}`);
            } catch (error) {
                log('error', `[Consumer] Error processing message ${event.messageId}`, error);
            } finally {
                this.processingCount--;
            }
        });
        log('info', `[Consumer] Consumer successfully started on queue: ${consumeQueue}`);

        this.scheduleReconnection();
        this.startHeartbeat();
        await this.startIdleMonitor();
    }

    private scheduleReconnection(): void {
        const maxUptime = this.config.maxUptimeMs ?? 0;
        if (maxUptime > 0) {
            log('info', `[Consumer] Scheduling reconnection after ${maxUptime}ms of uptime`);
            this.uptimeTimer = setTimeout(async () => {
                log("warn", `[Consumer] Max uptime (${maxUptime}ms) reached. Initiating reconnection...`);
                await this.reconnect();
            }, maxUptime);
        } else {
            log('info', '[Consumer] Auto-reconnection disabled (maxUptimeMs not configured)');
        }
    }

    private startHeartbeat(): void {
        const interval = this.config.heartbeatIntervalMs ?? 30000;
        log('info', `[Consumer] Starting heartbeat monitor with interval: ${interval}ms`);

        this.heartbeatTimer = setInterval(async () => {
            try {
                log('info', `[Consumer] Performing heartbeat check on queue: ${this.config.consumeQueue.queue}`);
                await this.queue.channel.checkQueue(this.config.consumeQueue.queue);
                log('info', '[Consumer] Heartbeat check successful');
            } catch (error) {
                log("error", `[Consumer] Heartbeat check failed - channel appears broken`, error);
                log("warn", `[Consumer] Initiating reconnection due to failed heartbeat...`);
                await this.reconnect();
            }
        }, interval);
    }

    private async startIdleMonitor(): Promise<void> {
        if (!this.config.exitIfIdle) {
            log('info', '[Consumer] Idle monitor disabled');
            return;
        }

        const checkInterval = this.config.idleCheckIntervalMs ?? 10000;
        const maxIdle = this.config.maxIdleChecks ?? 3;
        let idleCount = 0;

        log('info', `[Consumer] Starting idle monitor - will exit after ${maxIdle} checks with no messages (interval: ${checkInterval}ms)`);

        const checkQueues = async () => {
            if (this.reconnecting) {
                log('info', '[IdleMonitor] Skipping check - reconnection in progress');
                return;
            }

            try {
                log('info', '[IdleMonitor] Checking queue message counts...');
                let totalMessages = 0;

                const main = await this.queue.channel.checkQueue(this.config.consumeQueue.queue);
                totalMessages += main.messageCount;
                log('info', `[IdleMonitor] Main queue ${this.config.consumeQueue.queue}: ${main.messageCount} messages`);

                if (this.config.retryQueue?.queue) {
                    const retry = await this.queue.channel.checkQueue(this.config.retryQueue.queue);
                    totalMessages += retry.messageCount;
                    log('info', `[IdleMonitor] Retry queue ${this.config.retryQueue.queue}: ${retry.messageCount} messages`);
                }

                log('info', `[IdleMonitor] Total messages across all queues: ${totalMessages}`);

                if (totalMessages === 0) {
                    idleCount++;
                    log("warn", `[IdleMonitor] No messages found. Idle count: ${idleCount}/${maxIdle}`);
                } else {
                    if (idleCount > 0) {
                        log('info', `[IdleMonitor] Messages found, resetting idle count from ${idleCount} to 0`);
                    }
                    idleCount = 0;
                }

                if (idleCount >= maxIdle) {
                    log("error", `[IdleMonitor] Maximum idle checks (${maxIdle}) reached with no messages. Exiting process...`);
                    if (!this.queue.closed) {
                        log('info', '[IdleMonitor] Closing RabbitMQ connection before exit...');
                        await this.queue.connection.close();
                        log('info', '[IdleMonitor] Connection closed successfully');
                    }
                    log('info', '[IdleMonitor] Terminating process with exit code 0');
                    process.exit(0);
                }
            } catch (error) {
                log("error", `[IdleMonitor] Error during idle check`, error);
                log("warn", `[IdleMonitor] Skipped check due to error (reconnect may be in progress)`);
            }
        };

        setInterval(checkQueues, checkInterval);
    }

    private async waitForProcessing(): Promise<void> {
        if (this.processingCount === 0) {
            log('info', '[Consumer] No messages currently being processed');
            return;
        }

        log('info', `[Consumer] Waiting for ${this.processingCount} message(s) to finish processing...`);
        while (this.processingCount > 0) {
            await new Promise(res => setTimeout(res, 100));
        }
        log('info', '[Consumer] All messages processed, ready to proceed');
    }

    private async reconnect(): Promise<void> {
        if (this.reconnecting) {
            log('warn', '[Consumer] Reconnection already in progress, skipping duplicate request');
            return;
        }

        log('warn', '[Consumer] Starting reconnection process...');
        this.reconnecting = true;

        log('info', '[Consumer] Waiting for in-flight messages to complete...');
        await this.waitForProcessing();

        try {
            log('info', '[Consumer] Stopping timers and cleanup...');
            this.stopTimers();

            log('info', '[Consumer] Cancelling all active consumers...');
            await this.queue.cancelAllConsumers();

            log('info', '[Consumer] Closing channel...');
            await this.queue.channel.close();

            const socket = (this.queue.connection as any)?.connection?.stream;
            if (socket?.writable) {
                log('info', '[Consumer] Closing connection...');
                await this.queue.connection.close();
                log('info', '[Consumer] Connection closed successfully');
            } else {
                log('warn', '[Consumer] Connection socket not writable, skipping close');
            }
        } catch (err) {
            log("error", `[Consumer] Error during reconnection cleanup`, err);
        }

        const delay = this.config.reconnectDelayMs ?? 10000;
        log('info', `[Consumer] Scheduling restart in ${delay}ms...`);

        setTimeout(() => {
            log('info', '[Consumer] Reconnection delay completed, restarting consumer...');
            this.reconnecting = false;
            this.start().catch((error) => {
                log('error', '[Consumer] Failed to restart after reconnection', error);
            });
        }, delay);
    }

    private stopTimers(): void {
        if (this.uptimeTimer) {
            log('info', '[Consumer] Clearing uptime timer');
            clearTimeout(this.uptimeTimer);
            this.uptimeTimer = undefined;
        }
        if (this.heartbeatTimer) {
            log('info', '[Consumer] Clearing heartbeat timer');
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = undefined;
        }
    }
}
