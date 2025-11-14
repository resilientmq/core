import { EventMessage, EventProperties } from '../../src/types/resilience/event-message';
import { 
    ResilientConsumerConfig, 
    ResilientPublisherConfig,
    ExchangeConfig,
    RetryQueueConfig,
    EventProcessConfig
} from '../../src/types/resilience/rabbitmq-resilience-config';
import { EventPublishStatus } from '../../src/types/enum/event-publish-status';
import { EventConsumeStatus } from '../../src/types/enum/event-consume-status';

/**
 * Builder for creating EventMessage instances with fluent API.
 * Provides sensible defaults for all fields.
 */
export class EventBuilder<T = any> {
    private event: EventMessage<T>;

    constructor() {
        this.event = {
            messageId: `msg-${Date.now()}-${Math.random().toString(36).substring(7)}`,
            type: 'test.event',
            payload: {} as T,
            status: EventPublishStatus.PENDING,
            properties: {}
        };
    }

    withMessageId(messageId: string): EventBuilder<T> {
        this.event.messageId = messageId;
        return this;
    }

    withType(type: string): EventBuilder<T> {
        this.event.type = type;
        return this;
    }

    withPayload(payload: T): EventBuilder<T> {
        this.event.payload = payload;
        return this;
    }

    withStatus(status: EventPublishStatus | EventConsumeStatus | string): EventBuilder<T> {
        this.event.status = status;
        return this;
    }

    withRoutingKey(routingKey: string): EventBuilder<T> {
        this.event.routingKey = routingKey;
        return this;
    }

    withProperties(properties: EventProperties): EventBuilder<T> {
        this.event.properties = { ...this.event.properties, ...properties };
        return this;
    }

    withContentType(contentType: string): EventBuilder<T> {
        if (!this.event.properties) {
            this.event.properties = {};
        }
        this.event.properties.contentType = contentType;
        return this;
    }

    withCorrelationId(correlationId: string): EventBuilder<T> {
        if (!this.event.properties) {
            this.event.properties = {};
        }
        this.event.properties.correlationId = correlationId;
        return this;
    }

    withTimestamp(timestamp: number): EventBuilder<T> {
        if (!this.event.properties) {
            this.event.properties = {};
        }
        this.event.properties.timestamp = timestamp;
        return this;
    }

    withHeaders(headers: Record<string, any>): EventBuilder<T> {
        if (!this.event.properties) {
            this.event.properties = {};
        }
        this.event.properties.headers = headers;
        return this;
    }

    persistent(): EventBuilder<T> {
        if (!this.event.properties) {
            this.event.properties = {};
        }
        this.event.properties.deliveryMode = 2;
        return this;
    }

    build(): EventMessage<T> {
        return { ...this.event };
    }
}

/**
 * Builder for creating ResilientConsumerConfig instances with fluent API.
 * Provides sensible defaults for testing.
 */
export class ConsumerConfigBuilder {
    private config: Partial<ResilientConsumerConfig>;

    constructor() {
        this.config = {
            connection: 'amqp://localhost:5672',
            consumeQueue: {
                queue: 'test.queue',
                options: { durable: true }
            },
            eventsToProcess: [],
            prefetch: 10
        };
    }

    withConnection(connection: string): ConsumerConfigBuilder {
        this.config.connection = connection;
        return this;
    }

    withQueue(queue: string, options?: any): ConsumerConfigBuilder {
        this.config.consumeQueue = {
            queue,
            options: options || { durable: true }
        };
        return this;
    }

    withExchanges(exchanges: ExchangeConfig[]): ConsumerConfigBuilder {
        if (!this.config.consumeQueue) {
            this.config.consumeQueue = { queue: 'test.queue' };
        }
        this.config.consumeQueue.exchanges = exchanges;
        return this;
    }

    withRetryQueue(retryQueue: RetryQueueConfig): ConsumerConfigBuilder {
        this.config.retryQueue = retryQueue;
        return this;
    }

    withRetryConfig(queue: string, ttlMs: number = 5000, maxAttempts: number = 3): ConsumerConfigBuilder {
        this.config.retryQueue = {
            queue,
            ttlMs,
            maxAttempts,
            options: { durable: true }
        };
        return this;
    }

    withDeadLetterQueue(queue: string, options?: any): ConsumerConfigBuilder {
        this.config.deadLetterQueue = {
            queue,
            options: options || { durable: true }
        };
        return this;
    }

    withEventHandlers(handlers: EventProcessConfig[]): ConsumerConfigBuilder {
        this.config.eventsToProcess = handlers;
        return this;
    }

    withEventHandler(type: string, handler: (payload: any) => Promise<void>): ConsumerConfigBuilder {
        if (!this.config.eventsToProcess) {
            this.config.eventsToProcess = [];
        }
        this.config.eventsToProcess.push({ type, handler });
        return this;
    }

    withStore(store: any): ConsumerConfigBuilder {
        this.config.store = store;
        return this;
    }

    withPrefetch(prefetch: number): ConsumerConfigBuilder {
        this.config.prefetch = prefetch;
        return this;
    }

    withMiddleware(middleware: any[]): ConsumerConfigBuilder {
        this.config.middleware = middleware;
        return this;
    }

    withMaxUptimeMs(maxUptimeMs: number): ConsumerConfigBuilder {
        this.config.maxUptimeMs = maxUptimeMs;
        return this;
    }

    withReconnectDelayMs(reconnectDelayMs: number): ConsumerConfigBuilder {
        this.config.reconnectDelayMs = reconnectDelayMs;
        return this;
    }

    withExitIfIdle(exitIfIdle: boolean, idleCheckIntervalMs?: number, maxIdleChecks?: number): ConsumerConfigBuilder {
        this.config.exitIfIdle = exitIfIdle;
        if (idleCheckIntervalMs !== undefined) {
            this.config.idleCheckIntervalMs = idleCheckIntervalMs;
        }
        if (maxIdleChecks !== undefined) {
            this.config.maxIdleChecks = maxIdleChecks;
        }
        return this;
    }

    withIgnoreUnknownEvents(ignore: boolean): ConsumerConfigBuilder {
        this.config.ignoreUnknownEvents = ignore;
        return this;
    }

    build(): ResilientConsumerConfig {
        if (!this.config.eventsToProcess || this.config.eventsToProcess.length === 0) {
            throw new Error('At least one event handler must be configured');
        }
        return this.config as ResilientConsumerConfig;
    }
}

/**
 * Builder for creating ResilientPublisherConfig instances with fluent API.
 * Provides sensible defaults for testing.
 */
export class PublisherConfigBuilder {
    private config: Partial<ResilientPublisherConfig>;

    constructor() {
        this.config = {
            connection: 'amqp://localhost:5672',
            instantPublish: true
        };
    }

    withConnection(connection: string): PublisherConfigBuilder {
        this.config.connection = connection;
        return this;
    }

    withQueue(queue: string): PublisherConfigBuilder {
        this.config.queue = queue;
        return this;
    }

    withExchange(exchange: ExchangeConfig): PublisherConfigBuilder {
        this.config.exchange = exchange;
        return this;
    }

    withExchangeConfig(name: string, type: 'direct' | 'topic' | 'fanout' | 'headers', routingKey?: string): PublisherConfigBuilder {
        this.config.exchange = {
            name,
            type,
            routingKey,
            options: { durable: true }
        };
        return this;
    }

    withStore(store: any): PublisherConfigBuilder {
        this.config.store = store;
        return this;
    }

    withInstantPublish(instantPublish: boolean): PublisherConfigBuilder {
        this.config.instantPublish = instantPublish;
        return this;
    }

    withPendingEventsCheckInterval(intervalMs: number): PublisherConfigBuilder {
        this.config.pendingEventsCheckIntervalMs = intervalMs;
        return this;
    }

    withStoreConnectionRetries(retries: number, delayMs?: number): PublisherConfigBuilder {
        this.config.storeConnectionRetries = retries;
        if (delayMs !== undefined) {
            this.config.storeConnectionRetryDelayMs = delayMs;
        }
        return this;
    }

    build(): ResilientPublisherConfig {
        if (!this.config.instantPublish && !this.config.store) {
            throw new Error('Store is required when instantPublish is false');
        }
        return this.config as ResilientPublisherConfig;
    }
}

/**
 * Builder for creating ExchangeConfig instances.
 */
export class ExchangeConfigBuilder {
    private config: ExchangeConfig;

    constructor(name: string, type: 'direct' | 'topic' | 'fanout' | 'headers') {
        this.config = {
            name,
            type,
            options: { durable: true }
        };
    }

    withRoutingKey(routingKey: string): ExchangeConfigBuilder {
        this.config.routingKey = routingKey;
        return this;
    }

    withOptions(options: any): ExchangeConfigBuilder {
        this.config.options = options;
        return this;
    }

    durable(durable: boolean = true): ExchangeConfigBuilder {
        if (!this.config.options) {
            this.config.options = {};
        }
        this.config.options.durable = durable;
        return this;
    }

    autoDelete(autoDelete: boolean = true): ExchangeConfigBuilder {
        if (!this.config.options) {
            this.config.options = {};
        }
        this.config.options.autoDelete = autoDelete;
        return this;
    }

    build(): ExchangeConfig {
        return { ...this.config };
    }
}
