import { 
    ResilientConsumerConfig, 
    ResilientPublisherConfig,
    ExchangeConfig,
    RetryQueueConfig
} from '../../src/types/resilience/rabbitmq-resilience-config';

/**
 * Predefined test configurations for common scenarios.
 */

/**
 * Basic consumer configuration for simple testing.
 */
export const basicConsumerConfig: Partial<ResilientConsumerConfig> = {
    connection: 'amqp://localhost:5672',
    consumeQueue: {
        queue: 'test.queue',
        options: { durable: true }
    },
    prefetch: 10,
    eventsToProcess: []
};

/**
 * Consumer configuration with retry logic.
 */
export const consumerWithRetryConfig: Partial<ResilientConsumerConfig> = {
    connection: 'amqp://localhost:5672',
    consumeQueue: {
        queue: 'test.queue',
        options: { durable: true }
    },
    retryQueue: {
        queue: 'test.retry.queue',
        ttlMs: 5000,
        maxAttempts: 3,
        options: { durable: true }
    },
    prefetch: 10,
    eventsToProcess: []
};

/**
 * Consumer configuration with retry and dead-letter queue.
 */
export const consumerWithDLQConfig: Partial<ResilientConsumerConfig> = {
    connection: 'amqp://localhost:5672',
    consumeQueue: {
        queue: 'test.queue',
        options: { durable: true }
    },
    retryQueue: {
        queue: 'test.retry.queue',
        ttlMs: 5000,
        maxAttempts: 3,
        options: { durable: true }
    },
    deadLetterQueue: {
        queue: 'test.dlq',
        options: { durable: true }
    },
    prefetch: 10,
    eventsToProcess: []
};

/**
 * Consumer configuration with exchange binding.
 */
export const consumerWithExchangeConfig: Partial<ResilientConsumerConfig> = {
    connection: 'amqp://localhost:5672',
    consumeQueue: {
        queue: 'test.queue',
        exchanges: [
            {
                name: 'test.exchange',
                type: 'topic',
                routingKey: 'test.#',
                options: { durable: true }
            }
        ],
        options: { durable: true }
    },
    prefetch: 10,
    eventsToProcess: []
};

/**
 * Basic publisher configuration for simple testing.
 */
export const basicPublisherConfig: ResilientPublisherConfig = {
    connection: 'amqp://localhost:5672',
    queue: 'test.queue',
    instantPublish: true
};

/**
 * Publisher configuration with exchange.
 */
export const publisherWithExchangeConfig: ResilientPublisherConfig = {
    connection: 'amqp://localhost:5672',
    exchange: {
        name: 'test.exchange',
        type: 'topic',
        routingKey: 'test.event',
        options: { durable: true }
    },
    instantPublish: true
};

/**
 * Publisher configuration with persistence (non-instant publish).
 */
export const publisherWithPersistenceConfig: Partial<ResilientPublisherConfig> = {
    connection: 'amqp://localhost:5672',
    queue: 'test.queue',
    instantPublish: false,
    pendingEventsCheckIntervalMs: 1000
};

/**
 * Common exchange configurations.
 */

export const topicExchange: ExchangeConfig = {
    name: 'test.topic.exchange',
    type: 'topic',
    routingKey: 'test.#',
    options: { durable: true }
};

export const directExchange: ExchangeConfig = {
    name: 'test.direct.exchange',
    type: 'direct',
    routingKey: 'test.event',
    options: { durable: true }
};

export const fanoutExchange: ExchangeConfig = {
    name: 'test.fanout.exchange',
    type: 'fanout',
    options: { durable: true }
};

/**
 * Common retry queue configurations.
 */

export const shortRetryConfig: RetryQueueConfig = {
    queue: 'test.retry.short',
    ttlMs: 1000,
    maxAttempts: 2,
    options: { durable: true }
};

export const mediumRetryConfig: RetryQueueConfig = {
    queue: 'test.retry.medium',
    ttlMs: 5000,
    maxAttempts: 3,
    options: { durable: true }
};

export const longRetryConfig: RetryQueueConfig = {
    queue: 'test.retry.long',
    ttlMs: 30000,
    maxAttempts: 5,
    options: { durable: true }
};

/**
 * Queue names commonly used in tests.
 */
export const testQueues = {
    main: 'test.queue',
    retry: 'test.retry.queue',
    dlq: 'test.dlq',
    consumer1: 'test.consumer1.queue',
    consumer2: 'test.consumer2.queue',
    highVolume: 'test.high.volume.queue',
    stress: 'test.stress.queue'
};

/**
 * Exchange names commonly used in tests.
 */
export const testExchanges = {
    topic: 'test.topic.exchange',
    direct: 'test.direct.exchange',
    fanout: 'test.fanout.exchange',
    headers: 'test.headers.exchange'
};

/**
 * Routing keys commonly used in tests.
 */
export const testRoutingKeys = {
    userCreated: 'user.created',
    userUpdated: 'user.updated',
    userDeleted: 'user.deleted',
    orderPlaced: 'order.placed',
    orderCancelled: 'order.cancelled',
    paymentProcessed: 'payment.processed',
    notificationSent: 'notification.sent',
    wildcard: 'test.#',
    singleWildcard: 'test.*'
};
