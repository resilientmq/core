import type {EventMessage} from '../resilience/event-message';
import type {ExchangeConfig} from '../resilience/rabbitmq-resilience-config';

/**
 * Options for publishing an event to a message queue.
 */
export interface PublishOptions {
    /**
     * If provided, the message will be routed using this exchange.
     * If not provided, the message will be sent directly to the queue.
     */
    exchange?: ExchangeConfig;

}

/**
 * Represents an abstract interface for a message queue system like RabbitMQ.
 * This abstraction allows different implementations (e.g., AMQP, mock, in-memory).
 */
export interface MessageQueue {
    /**
     * Establishes a connection to the message broker and sets up a channel.
     *
     * @param prefetch - The maximum number of unacknowledged messages the consumer can handle.
     *                   Defaults to 1 to ensure strict message ordering and retry safety.
     */
    connect(prefetch?: number): Promise<void>;

    /**
     * Publishes an event message to a target queue or exchange.
     *
     * @param queue - The name of the queue. Used if no exchange is provided.
     * @param event - The event message to send.
     * @param options - Optional configuration for publishing (exchange, properties).
     */
    publish(
        queue: string,
        event: EventMessage,
        options?: PublishOptions
    ): Promise<void>;

    /**
     * Subscribes to a queue and consumes messages using the provided handler.
     *
     * @param queue - The name of the queue to consume messages from.
     * @param onMessage - Async callback to handle each incoming message.
     */
    consume(
        queue: string,
        onMessage: (event: EventMessage) => Promise<void>
    ): Promise<void>;
}
