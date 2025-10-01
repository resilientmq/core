import { ResilientEventConsumeProcessor } from "./resilient-event-consume-processor";
import { AmqpQueue } from "../broker/amqp-queue";
import { log } from "../logger/logger";
import { EventMessage, RabbitMQResilientProcessorConfig, ResilientConsumerConfig } from "../types";

export class ResilientConsumer {
    private processor!: ResilientEventConsumeProcessor;
    private queue!: AmqpQueue;
    private uptimeTimer?: NodeJS.Timeout;
    private heartbeatTimer?: NodeJS.Timeout;
    private reconnecting = false;

    constructor(private readonly config: ResilientConsumerConfig) { }

    public async start(): Promise<void> {
        await this.setupAndConsume();
    }

    private async setupAndConsume(): Promise<void> {
        this.queue = new AmqpQueue(this.config.connection);
        await this.queue.connect(this.config.prefetch ?? 1);

        // Setup consume queue
        const { queue: consumeQueue, options, exchanges } = this.config.consumeQueue;
        await this.queue.channel.assertQueue(consumeQueue, options);

        // Bind to exchanges if provided
        if (exchanges?.length) {
            for (const additionalExchange of exchanges) {
                await this.queue.channel.assertExchange(additionalExchange.name, additionalExchange.type, additionalExchange.options);
                await this.queue.channel.bindQueue(consumeQueue, additionalExchange.name, additionalExchange.routingKey ?? '');
            }
        }

        // Retry queue
        if (this.config.retryQueue) {
            const { queue, exchange, options } = this.config.retryQueue;
            await this.queue.channel.assertQueue(queue, {
                ...options,
                arguments: {
                    'x-dead-letter-exchange': this.config.retryQueue.exchange?.name,
                    'x-dead-letter-routing-key': " ",
                    'x-message-ttl': this.config.retryQueue.ttlMs ?? 10000
                }
            });
            if (exchange) {
                await this.queue.channel.assertExchange(exchange.name, exchange.type, exchange.options);
                await this.queue.channel.bindQueue(queue, exchange.name, exchange.routingKey ?? '');
            }
        }

        if (this.config.deadLetterQueue) {
            const { queue, exchange, options } = this.config.deadLetterQueue;
            await this.queue.channel.assertQueue(queue, options);
            if (exchange) {
                await this.queue.channel.assertExchange(exchange.name, exchange.type, exchange.options);
                await this.queue.channel.bindQueue(queue, exchange.name, exchange.routingKey ?? '');
            }
        }

        this.processor = new ResilientEventConsumeProcessor({
            ...this.config,
            broker: this.queue
        } as RabbitMQResilientProcessorConfig);

        await this.queue.consume(consumeQueue, (event: EventMessage) =>
            this.processor.process(event)
        );

        this.scheduleReconnection();
        this.startHeartbeat();
        await this.startIdleMonitor();
    }

    private scheduleReconnection(): void {
        const maxUptime = this.config.maxUptimeMs ?? 0;
        if (maxUptime > 0) {
            this.uptimeTimer = setTimeout(async () => {
                log("warn", `[ResilientConsumer] Max uptime reached. Reconnecting...`);
                await this.reconnect();
            }, maxUptime);
        }
    }

    private startHeartbeat(): void {
        const interval = this.config.heartbeatIntervalMs ?? 30000;
        this.heartbeatTimer = setInterval(async () => {
            try {
                await this.queue.channel.checkQueue(this.config.consumeQueue.queue);
            } catch (err) {
                log("warn", `[ResilientConsumer] Detected broken channel. Reconnecting...`);
                await this.reconnect();
            }
        }, interval);
    }

    private async startIdleMonitor(): Promise<void> {
        if (!this.config.exitIfIdle) return;

        const checkInterval = this.config.idleCheckIntervalMs ?? 10000;
        const maxIdle = this.config.maxIdleChecks ?? 3;
        let idleCount = 0;

        const checkQueues = async () => {
            if (this.reconnecting) return;

            try {
                let totalMessages = 0;

                // Check main consume queue
                const main = await this.queue.channel.checkQueue(this.config.consumeQueue.queue);
                totalMessages += main.messageCount;

                // Check retry queue if exists
                if (this.config.retryQueue?.queue) {
                    const retry = await this.queue.channel.checkQueue(this.config.retryQueue.queue);
                    totalMessages += retry.messageCount;
                }

                if (totalMessages === 0) {
                    idleCount++;
                    log("info", `[IdleMonitor] No messages. Idle count: ${idleCount}/${maxIdle}`);
                } else {
                    idleCount = 0;
                }

                if (idleCount >= maxIdle) {
                    log("warn", `[IdleMonitor] Exiting: no messages after ${maxIdle} checks.`);
                    if (!this.queue.closed) {
                        await this.queue.connection.close();
                    }
                    process.exit(0);
                }
            } catch (err) {
                log("warn", `[IdleMonitor] Skipped check due to reconnect in progress.`);
            }
        };

        setInterval(checkQueues, checkInterval);
    }

    private async reconnect(): Promise<void> {
        if (this.reconnecting) return;
        this.reconnecting = true;

        try {
            this.stopTimers();
            await this.queue.cancelAllConsumers();
            await this.queue.channel.close();

            const socket = (this.queue.connection as any)?.connection?.stream;
            if (socket?.writable) {
                await this.queue.connection.close();
            }
        } catch (err) {
            log("warn", `[ResilientConsumer] Reconnect failed:`, err);
        }

        const delay = this.config.reconnectDelayMs ?? 10000;
        setTimeout(() => {
            this.reconnecting = false;
            this.start();
        }, delay);
    }

    private stopTimers(): void {
        if (this.uptimeTimer) clearTimeout(this.uptimeTimer);
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    }
}
