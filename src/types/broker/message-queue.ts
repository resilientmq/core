import type {EventMessage, EventProperties} from '../resilience/event-message';
import type {ExchangeConfig} from '../resilience/rabbitmq-resilience-config';

/** Controls how a confirmed publication is routed. */
export interface PublishOptions {
    /** Exchange used for routing instead of the default exchange. */
    exchange?: ExchangeConfig;

    /** Per-message routing key used when publishing through an exchange. */
    routingKey?: string;

    /** Maximum time to wait for a publisher confirm. */
    confirmTimeoutMs?: number;
}

/** Broker metadata attached to a raw AMQP delivery. */
export interface RawMessageDelivery {
    /** Unmodified message body. */
    content: Buffer;

    /** AMQP message properties supplied by the publisher and RabbitMQ. */
    properties: EventProperties;

    /** Exchange that routed the delivery. */
    exchange: string;

    /** Routing key used for the delivery. */
    routingKey: string;

    /** Indicates that RabbitMQ has redelivered the message. */
    redelivered: boolean;
}

/** Disposition applied to a delivery after its handler completes. */
export type DeliveryDisposition = 'ack' | 'reject' | 'requeue';

/** Reason why an AMQP transport became unavailable. */
export interface MessageQueueDisconnect {
    /** Transport component that closed or failed. */
    source: 'connection' | 'channel';

    /** Error emitted by the transport, when available. */
    error?: Error;
}

/** Represents the broker operations required by the resilience layer. */
export interface MessageQueue {
    /** Establishes an AMQP connection and applies consumer prefetch. */
    connect(prefetch?: number): Promise<void>;

    /** Publishes JSON and resolves only after a positive broker confirm. */
    publish(destination: string, event: EventMessage, options?: PublishOptions): Promise<void>;

    /** Publishes an unmodified body and resolves only after a positive broker confirm. */
    publishRaw(
        destination: string,
        content: Buffer,
        properties?: EventProperties,
        options?: PublishOptions
    ): Promise<void>;

    /** Consumes decoded JSON events using automatic success and failure dispositions. */
    consume(queue: string, onMessage: (event: EventMessage) => Promise<void>): Promise<void>;

    /** Consumes raw deliveries and applies the disposition returned by the handler. */
    consumeRaw(
        queue: string,
        onMessage: (delivery: RawMessageDelivery) => Promise<DeliveryDisposition>
    ): Promise<void>;

    /** Subscribes to connection and channel failures. */
    onDisconnect(listener: (disconnect: MessageQueueDisconnect) => void): () => void;
}
