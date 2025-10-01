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

    constructor(private readonly config: ResilientConsumerConfig) {}

    public async start(): Promise<void> {
        await this.setupAndConsume();
    }

    private async setupAndConsume(): Promise<void> {
        this.queue = new AmqpQueue(this.config.connection);
        await this.queue.connect(this.config.prefetch ?? 1);

        const { queue: consumeQueue, options, exchanges } = this.config.consumeQueue;
        await this.queue.channel.assertQueue(consumeQueue, options);

        if (exchanges?.length) {
            for (const additionalExchange of exchanges) {
                await this.queue.channel.assertExchange(additionalExchange.name, additionalExchange.type, additionalExchange.options);
                await this.queue.channel.bindQueue(consumeQueue, additionalExchange.name, additionalExchange.routingKey ?? "");
            }

            const restrictiveExchange = exchanges.find((e: any) => e.routingKey) || exchanges[0];

            if (this.config.retryQueue) {
                const { queue, exchange, options } = this.config.retryQueue;
                await this.queue.channel.assertQueue(queue, {
                    ...options,
                    arguments: {
                        "x-dead-letter-exchange": restrictiveExchange.name,
                        "x-dead-letter-routing-key": restrictiveExchange.routingKey ?? "",
                        "x-message-ttl": this.config.retryQueue.ttlMs ?? 10000
                    }
                });
                if (exchange) {
                    await this.queue.channel.assertExchange(exchange.name, exchange.type, exchange.options);
                    await this.queue.channel.bindQueue(queue, exchange.name, exchange.routingKey ?? "");
                }
            }

            if (this.config.deadLetterQueue) {
                const { queue, exchange, options } = this.config.deadLetterQueue;
                await this.queue.channel.assertQueue(queue, options);
                if (exchange) {
                    await this.queue.channel.assertExchange(exchange.name, exchange.type, exchange.options);
                    await this.queue.channel.bindQueue(queue, exchange.name, exchange.routingKey ?? "");
                }
            }
        }

        this.processor = new ResilientEventConsumeProcessor({
            ...this.config,
            broker: this.queue
        } as RabbitMQResilientProcessorConfig);

        await this.queue.consume(consumeQueue, async (event: EventMessage) => {
            this.processingCount++;
            try {
                await this.processor.process(event);
            } finally {
                this.processingCount--;
            }
        });

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
            } catch {
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
                const main = await this.queue.channel.checkQueue(this.config.consumeQueue.queue);
                totalMessages += main.messageCount;

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
            } catch {
                log("warn", `[IdleMonitor] Skipped check due to reconnect in progress.`);
            }
        };

        setInterval(checkQueues, checkInterval);
    }

    private async waitForProcessing(): Promise<void> {
        while (this.processingCount > 0) {
            await new Promise(res => setTimeout(res, 100));
        }
    }

    private async reconnect(): Promise<void> {
        if (this.reconnecting) return;
        this.reconnecting = true;

        await this.waitForProcessing();

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
