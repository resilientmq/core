import {createHash, randomUUID} from 'crypto';
import {AmqpQueue} from '../broker/amqp-queue';
import {log} from '../logger/logger';
import {MetricsCollector, MetricsSink, ResilienceMetricEvent, ResilientMQMetrics} from '../metrics/metrics-collector';
import {
    RabbitMQResilientProcessorConfig,
    ResilientConsumerConfig
} from '../types';
import {ResilientEventConsumeProcessor} from './resilient-event-consume-processor';

/** Long-lived resilient consumer driven by AMQP heartbeat and lifecycle events. */
export class ResilientConsumer {
    private processor?: ResilientEventConsumeProcessor;
    private queue?: AmqpQueue;
    private recoveryPromise?: Promise<void>;
    private cancelRecoveryDelay?: () => void;
    private startPromise?: Promise<void>;
    private stopPromise?: Promise<void>;
    private desiredRunning = false;
    private generation = 0;
    private _processingCount = 0;
    private readonly instanceId = randomUUID();
    private readonly serviceId: string;
    private readonly metrics?: MetricsCollector;
    private readonly metricsSink?: MetricsSink;

    constructor(private readonly config: ResilientConsumerConfig) {
        this.validateConfig();
        this.serviceId = createHash('sha256')
            .update(config.serviceId ?? config.consumeQueue.queue)
            .update('\0')
            .update(config.consumeQueue.queue)
            .digest('hex');
        this.metrics = config.metricsEnabled ? new MetricsCollector() : undefined;
        this.metricsSink = this.composeMetricsSink(this.metrics, config.metricsSink);
    }

    /** Number of handlers currently executing in this process. */
    get processingCount(): number { return this._processingCount; }

    /** Returns the optional in-process aggregate snapshot. */
    getMetrics(): ResilientMQMetrics | undefined { return this.metrics?.getSnapshot(); }

    /** Starts the consumer and establishes its first AMQP generation. */
    async start(): Promise<void> {
        if (this.startPromise) return this.startPromise;
        this.startPromise = this.startInternal().finally(() => {
            this.startPromise = undefined;
        });
        return this.startPromise;
    }

    private async startInternal(): Promise<void> {
        if (this.stopPromise) await this.stopPromise;
        if (this.desiredRunning) return;
        this.desiredRunning = true;
        this.generation++;
        try {
            await this.checkStoreConnection();
            await this.startGeneration(this.generation);
        } catch (error) {
            this.desiredRunning = false;
            await this.queue?.forceClose();
            throw error;
        }
    }

    /** Cancels deliveries first, drains bounded work and closes the active generation. */
    async stop(): Promise<void> {
        if (this.stopPromise) return this.stopPromise;
        this.desiredRunning = false;
        this.generation++;
        this.cancelRecoveryDelay?.();
        this.stopPromise = this.stopInternal().finally(() => {
            this.stopPromise = undefined;
        });
        return this.stopPromise;
    }

    private async stopInternal(): Promise<void> {
        const processor = this.processor;
        const queue = this.queue;
        this.processor = undefined;
        this.queue = undefined;
        processor?.abortActive();
        if (!queue) return;

        const timeoutMs = this.config.shutdownTimeoutMs ?? 30000;
        await queue.cancelAllConsumers();
        const drained = await queue.waitForProcessing(timeoutMs);
        if (drained) await queue.disconnect(Math.min(5000, timeoutMs));
        else await queue.forceClose();
        log('info', '[Consumer] Stopped');
    }

    private async startGeneration(generation: number): Promise<void> {
        const queue = new AmqpQueue(this.config.connection);
        this.queue = queue;
        queue.onDisconnect(disconnect => {
            this.emit({
                name: 'broker.disconnected',
                errorName: disconnect.error?.name
            });
            this.requestRecovery(generation);
        });

        await queue.connect(this.config.prefetch ?? 1);
        if (!this.desiredRunning || generation !== this.generation) {
            await queue.forceClose();
            return;
        }

        await this.setupQueuesAndExchanges(queue);
        const processor = new ResilientEventConsumeProcessor({
            ...this.config,
            broker: queue,
            resolvedServiceId: this.serviceId,
            instanceId: this.instanceId,
            metricsSink: this.metricsSink
        } as RabbitMQResilientProcessorConfig);
        this.processor = processor;

        await queue.consumeRaw(this.config.consumeQueue.queue, async delivery => {
            if (!this.desiredRunning || generation !== this.generation) return 'requeue';
            this._processingCount++;
            try {
                return await processor.processRaw(delivery);
            } catch (error) {
                log('error', '[Consumer] Delivery could not be processed safely', error);
                await this.sleep(this.config.storeConnectionRetryDelayMs ?? 1000);
                return 'requeue';
            } finally {
                this._processingCount--;
            }
        });

        this.emit({name: 'broker.connected'});
        log('info', `[Consumer] Consuming ${this.config.consumeQueue.queue} with prefetch ${this.config.prefetch ?? 1}`);
    }

    private requestRecovery(failedGeneration: number): void {
        if (!this.desiredRunning || failedGeneration !== this.generation || this.recoveryPromise) return;
        this.recoveryPromise = this.recover(failedGeneration).finally(() => {
            this.recoveryPromise = undefined;
        });
    }

    private async recover(failedGeneration: number): Promise<void> {
        if (failedGeneration !== this.generation) return;
        this.generation++;
        const recoveryGeneration = this.generation;
        const oldProcessor = this.processor;
        const oldQueue = this.queue;
        this.processor = undefined;
        this.queue = undefined;
        oldProcessor?.abortActive();

        if (oldQueue) {
            await oldQueue.cancelAllConsumers();
            await oldQueue.forceClose();
        }

        const initialDelay = this.config.reconnectDelayMs ?? 250;
        const maximumDelay = this.config.reconnectMaxDelayMs ?? 30000;
        let delay = initialDelay;

        while (this.desiredRunning && recoveryGeneration === this.generation) {
            await this.recoveryDelay(this.withJitter(delay));
            try {
                await this.startGeneration(recoveryGeneration);
                return;
            } catch (error) {
                log('error', `[Consumer] Recovery attempt failed; retrying in ${delay}ms`, error);
                await (this.queue as AmqpQueue | undefined)?.forceClose();
                this.queue = undefined;
                delay = Math.min(maximumDelay, Math.max(initialDelay, delay * 2));
            }
        }
    }

    private async setupQueuesAndExchanges(queue: AmqpQueue): Promise<void> {
        const channel = queue.channel;
        const {queue: consumeQueue, options, exchanges} = this.config.consumeQueue;
        const deadLetterQueue = this.config.deadLetterQueue;
        const retryQueue = this.config.retryQueue;
        let retryExchangeName = '';

        if (deadLetterQueue) {
            const deadExchange = deadLetterQueue.exchange;
            if (deadExchange) {
                await channel.assertExchange(deadExchange.name, deadExchange.type, deadExchange.options);
            }
            await channel.assertQueue(deadLetterQueue.queue, deadLetterQueue.options);
            if (deadExchange) {
                await channel.bindQueue(
                    deadLetterQueue.queue,
                    deadExchange.name,
                    deadExchange.routingKey ?? ''
                );
            }
        }

        if (retryQueue) {
            const retryExchange = retryQueue.exchange;
            if (retryExchange) {
                retryExchangeName = retryExchange.name;
                await channel.assertExchange(retryExchange.name, retryExchange.type, retryExchange.options);
            }
            await channel.assertQueue(retryQueue.queue, {
                ...retryQueue.options,
                arguments: {
                    ...(retryQueue.options?.arguments ?? {}),
                    'x-dead-letter-exchange': '',
                    'x-dead-letter-routing-key': consumeQueue,
                    'x-message-ttl': retryQueue.ttlMs ?? 5000
                }
            });
            if (retryExchange) {
                await channel.bindQueue(retryQueue.queue, retryExchange.name, retryExchange.routingKey ?? '');
            }
        }

        const mainQueueArguments: Record<string, unknown> = {...(options?.arguments ?? {})};
        if (this.config.singleActiveConsumer !== undefined) {
            mainQueueArguments['x-single-active-consumer'] = this.config.singleActiveConsumer;
        }
        if (retryQueue) {
            mainQueueArguments['x-dead-letter-exchange'] = retryExchangeName;
            mainQueueArguments['x-dead-letter-routing-key'] = retryExchangeName
                ? retryQueue.exchange?.routingKey ?? ''
                : retryQueue.queue;
        }

        if (exchanges) {
            for (const exchange of exchanges) {
                await channel.assertExchange(exchange.name, exchange.type, exchange.options);
            }
        }
        await channel.assertQueue(consumeQueue, {...options, arguments: mainQueueArguments});
        if (exchanges) {
            for (const exchange of exchanges) {
                await channel.bindQueue(consumeQueue, exchange.name, exchange.routingKey ?? '');
            }
        }
    }

    private async checkStoreConnection(): Promise<void> {
        const store = this.config.store;
        if (!store) return;
        const attempts = this.config.storeConnectionRetries ?? 3;
        const delay = this.config.storeConnectionRetryDelayMs ?? 1000;
        let lastError: unknown;

        for (let attempt = 1; attempt <= attempts; attempt++) {
            try {
                await store.getEvent({messageId: '__resilientmq_health__', type: '__health__', payload: null});
                return;
            } catch (error) {
                lastError = error;
                if (attempt < attempts) await this.sleep(delay);
            }
        }
        const detail = lastError instanceof Error ? `: ${lastError.message}` : '';
        throw new Error(`Failed to connect to store after ${attempts} attempts${detail}`);
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

    private withJitter(delay: number): number {
        return Math.max(1, Math.round(delay * (0.8 + Math.random() * 0.4)));
    }

    private async sleep(ms: number): Promise<void> {
        await new Promise(resolve => setTimeout(resolve, ms));
    }

    private async recoveryDelay(ms: number): Promise<void> {
        await new Promise<void>(resolve => {
            let settled = false;
            const finish = () => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                if (this.cancelRecoveryDelay === finish) this.cancelRecoveryDelay = undefined;
                resolve();
            };
            const timer = setTimeout(finish, ms);
            this.cancelRecoveryDelay = finish;
        });
    }

    private validateConfig(): void {
        if (!this.config.consumeQueue?.queue) {
            throw new Error('[Consumer] Configuration error: "consumeQueue.queue" is required');
        }
        if (!this.config.eventsToProcess?.length) {
            throw new Error('[Consumer] Configuration error: "eventsToProcess" must have at least one event handler');
        }
        if (this.config.prefetch !== undefined && (!Number.isInteger(this.config.prefetch) || this.config.prefetch < 0)) {
            throw new Error('[Consumer] Configuration error: "prefetch" must be a non-negative integer');
        }
        if (this.config.retryQueue?.maxAttempts !== undefined
            && (!Number.isInteger(this.config.retryQueue.maxAttempts) || this.config.retryQueue.maxAttempts <= 0)) {
            throw new Error('[Consumer] Configuration error: "retryQueue.maxAttempts" must be a positive integer');
        }
        if (this.config.retryQueue?.ttlMs !== undefined
            && (!Number.isInteger(this.config.retryQueue.ttlMs) || this.config.retryQueue.ttlMs < 0)) {
            throw new Error('[Consumer] Configuration error: "retryQueue.ttlMs" must be a non-negative integer');
        }
        this.assertPositiveInteger('storeConnectionRetries', this.config.storeConnectionRetries);
        this.assertNonNegativeInteger('storeConnectionRetryDelayMs', this.config.storeConnectionRetryDelayMs);
        this.assertPositiveFinite('reconnectDelayMs', this.config.reconnectDelayMs);
        this.assertPositiveFinite('reconnectMaxDelayMs', this.config.reconnectMaxDelayMs);
        this.assertPositiveFinite('shutdownTimeoutMs', this.config.shutdownTimeoutMs);
        if ((this.config.reconnectMaxDelayMs ?? 30000) < (this.config.reconnectDelayMs ?? 250)) {
            throw new Error('[Consumer] Configuration error: "reconnectMaxDelayMs" must not be less than "reconnectDelayMs"');
        }
        const processingTimeout = this.config.processingTimeoutMs ?? 300000;
        const lease = this.config.processingLeaseMs ?? 330000;
        if (!Number.isFinite(processingTimeout) || !Number.isFinite(lease)
            || processingTimeout <= 0 || lease <= processingTimeout) {
            throw new Error('[Consumer] Configuration error: "processingLeaseMs" must exceed "processingTimeoutMs"');
        }
        const store = this.config.store;
        if (store && (!store.claimConsumeEvent || !store.transitionConsumeEvent)) {
            throw new Error('[Consumer] Configuration error: store requires atomic claimConsumeEvent() and transitionConsumeEvent()');
        }
    }

    private assertPositiveInteger(name: string, value: number | undefined): void {
        if (value !== undefined && (!Number.isInteger(value) || value <= 0)) {
            throw new Error(`[Consumer] Configuration error: "${name}" must be a positive integer`);
        }
    }

    private assertNonNegativeInteger(name: string, value: number | undefined): void {
        if (value !== undefined && (!Number.isInteger(value) || value < 0)) {
            throw new Error(`[Consumer] Configuration error: "${name}" must be a non-negative integer`);
        }
    }

    private assertPositiveFinite(name: string, value: number | undefined): void {
        if (value !== undefined && (!Number.isFinite(value) || value <= 0)) {
            throw new Error(`[Consumer] Configuration error: "${name}" must be positive and finite`);
        }
    }
}
