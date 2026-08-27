import type {Options} from 'amqplib';
import type {MetricsSink} from '../../metrics/metrics-collector';
import type {MessageQueue} from '../broker/message-queue';
import type {EventMessage} from './event-message';
import type {
    ConsumerEventStore,
    DistributedPublisherEventStore,
    PublisherEventStore
} from './event-store';
import type {Middleware} from './middleware';

/** RabbitMQ exchange declaration and routing defaults. */
export interface ExchangeConfig {
    /** Exchange name. */
    name: string;

    /** RabbitMQ exchange type. */
    type: 'direct' | 'topic' | 'fanout' | 'headers';

    /** Default binding or publication routing key. */
    routingKey?: string;

    /** Exchange declaration options. */
    options?: Options.AssertExchange;
}

/** RabbitMQ queue declaration with an optional exchange binding. */
export interface QueueBinding {
    /** Queue name. */
    queue: string;

    /** Queue declaration options. */
    options?: Options.AssertQueue;

    /** Optional exchange binding. */
    exchange?: ExchangeConfig;
}

/** Retry queue declaration controlled by RabbitMQ dead-letter headers. */
export interface RetryQueueConfig extends QueueBinding {
    /** Delay before RabbitMQ dead-letters a retry back to the main queue. */
    ttlMs?: number;

    /** Maximum total delivery attempts, including the first delivery. */
    maxAttempts?: number;
}

/** Cooperative context supplied to each event handler. */
export interface EventProcessingContext {
    /** Signal aborted on processing timeout, shutdown or connection replacement. */
    signal: AbortSignal;

    /** Current RabbitMQ delivery attempt. */
    attempt: number;

    /** Stable hash shared by all replicas of the service. */
    serviceId: string;

    /** Ephemeral identifier of the current process. */
    instanceId: string;

    /** Unique identifier for this delivery execution. */
    deliveryId: string;

    /** Indicates RabbitMQ redelivery. */
    redelivered: boolean;

    /** Inbox fencing token when the store supports atomic claims. */
    fencingToken?: string | number;
}

/** Handler declaration for one event type. */
export interface EventProcessConfig<T = unknown> {
    /** Logical event type. */
    type: string;

    /** Processes one event with optional cooperative cancellation and fencing context. */
    handler: (event: EventMessage<T>, context: EventProcessingContext) => Promise<void>;
}

/** Mutable control passed to the start hook. */
export interface EventControl {
    /** Skips the handler and acknowledges the delivery when set. */
    skipEvent: boolean;
}

/** Hooks emitted around event processing. */
export interface ResilientEventHooks {
    /** Runs before event processing. */
    onEventStart?: (event: EventMessage, control: EventControl) => void;

    /** Runs after durable completion. */
    onSuccess?: (event: EventMessage) => void;

    /** Runs after a processing failure. */
    onError?: (event: EventMessage, error: Error) => void;
}

/** Configuration for a resilient RabbitMQ consumer. */
export interface ResilientConsumerConfig {
    /** AMQP connection URI or parameters. */
    connection: string | Options.Connect;

    /** Stable service identity used to scope inbox deduplication. */
    serviceId?: string;

    /** Queue and exchange bindings consumed by the service. */
    consumeQueue: Omit<QueueBinding, 'exchange'> & {exchanges?: ExchangeConfig[]};

    /** RabbitMQ TTL queue used for delayed retries. */
    retryQueue?: RetryQueueConfig;

    /** Final dead-letter destination. */
    deadLetterQueue?: QueueBinding;

    /** Maximum unacknowledged deliveries for this consumer channel. */
    prefetch?: number;

    /** Enables RabbitMQ single-active-consumer on the main queue. */
    singleActiveConsumer?: boolean;

    /** Event handlers keyed by logical type. */
    eventsToProcess: EventProcessConfig[];

    /** Acknowledges unknown event types when true. */
    ignoreUnknownEvents?: boolean;

    /** Lifecycle hooks. */
    events?: ResilientEventHooks;

    /** Middleware applied around handlers. */
    middleware?: Middleware[];

    /** Optional inbox store with atomic claim and fenced transition support. */
    store?: ConsumerEventStore;

    /** Maximum store health-check attempts during startup. */
    storeConnectionRetries?: number;

    /** Delay between store health-check attempts and unavailable deliveries. */
    storeConnectionRetryDelayMs?: number;

    /** Initial delay for event-driven AMQP recovery. */
    reconnectDelayMs?: number;

    /** Maximum delay for event-driven AMQP recovery. */
    reconnectMaxDelayMs?: number;

    /** Maximum handler duration before cooperative abort and message recovery. */
    processingTimeoutMs?: number;

    /** Inbox lease duration for stores with atomic claims. */
    processingLeaseMs?: number;

    /** Maximum graceful drain time before the channel is force-closed. */
    shutdownTimeoutMs?: number;

    /** Optional event-oriented metrics destination. */
    metricsSink?: MetricsSink;

    /** Enables the built-in in-memory metric collector. */
    metricsEnabled?: boolean;

}

/** Runtime configuration used by the delivery processor. */
export type RabbitMQResilientProcessorConfig = ResilientConsumerConfig & {
    /** Connected broker transport. */
    broker: MessageQueue;

    /** Resolved stable service hash. */
    resolvedServiceId?: string;

    /** Resolved process instance identifier. */
    instanceId?: string;
};

/** Controls one pending outbox processing pass. */
export interface ProcessPendingEventsOptions {
    /** Maximum events claimed per store round trip. */
    batchSize?: number;

    /** Maximum confirmed publications started per second. */
    maxPublishesPerSecond?: number;

    /** Maximum simultaneous unconfirmed publications. */
    maxConcurrentPublishes?: number;
}

/** Shared configuration for resilient confirmed publishing and outbox processing. */
interface ResilientPublisherBaseConfig {
    /** AMQP connection URI or parameters. */
    connection: string | Options.Connect;

    /** Stable service identity used to scope outbox claims. */
    serviceId?: string;

    /** Direct queue destination when no exchange is configured. */
    queue?: string;

    /** Exchange destination. */
    exchange?: ExchangeConfig;

    /** Periodic interval for pending outbox processing. */
    pendingEventsCheckIntervalMs?: number;

    /** Maximum simultaneous unconfirmed publications. */
    maxConcurrentPublishes?: number;

    /** Maximum time to wait for each RabbitMQ confirm. */
    confirmTimeoutMs?: number;

    /** Duration of each distributed outbox claim. */
    outboxLeaseMs?: number;

    /** Delay before a failed outbox publication becomes eligible again. */
    outboxRetryDelayMs?: number;

    /** Default pending claim batch size. */
    pendingEventsBatchSize?: number;

    /** Default maximum confirmed publications per second. */
    pendingEventsMaxPublishesPerSecond?: number;

    /** Default maximum simultaneous pending publications. */
    pendingEventsMaxConcurrentPublishes?: number;

    /** Maximum time to drain pending and confirmed work during disconnect. */
    shutdownTimeoutMs?: number;

    /** Optional event-oriented metrics destination. */
    metricsSink?: MetricsSink;

    /** Enables the built-in in-memory metric collector. */
    metricsEnabled?: boolean;

}

/** Configuration for resilient confirmed publishing and outbox processing. */
export type ResilientPublisherConfig = ResilientPublisherBaseConfig & (
    | {
        /** Enables distributed deferred publication. */
        instantPublish: false;

        /** Outbox store with atomic pending claims and fenced transitions. */
        store: DistributedPublisherEventStore;
    }
    | {
        /** Publishes immediately unless storeOnly is requested. */
        instantPublish?: true;

        /** Optional outbox store with idempotent enqueue and fenced transitions. */
        store?: PublisherEventStore;
    }
);
