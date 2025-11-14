/**
 * Optional AMQP message properties. These provide metadata used for
 * tracing, routing, expiration, retries, and RPC behaviors.
 */
export type EventProperties = {
    /**
     * MIME content type (e.g., 'application/json').
     */
    contentType?: string;

    /**
     * Encoding applied to the message content (e.g., 'gzip').
     */
    contentEncoding?: string;

    /**
     * Custom headers to include with the message.
     */
    headers?: Record<string, any>;

    /**
     * Whether the message is persistent (2) or transient (1).
     */
    deliveryMode?: number;

    /**
     * Priority value (0–9).
     */
    priority?: number;

    /**
     * Used for correlating RPC requests and responses.
     */
    correlationId?: string;

    /**
     * The queue to reply to in an RPC pattern.
     */
    replyTo?: string;

    /**
     * Expiration time for the message in milliseconds, as a string.
     */
    expiration?: string;

    /**
     * A unique message ID for tracing or deduplication.
     */
    messageId?: string;

    /**
     * Time when the message was published (UNIX timestamp in seconds).
     */
    timestamp?: number;

    /**
     * Logical type/category of the message (e.g., 'user.created').
     */
    type?: string;

    /**
     * Identifier of the user who sent the message.
     */
    userId?: string;

    /**
     * Identifier of the originating application.
     */
    appId?: string;
};

/**
 * Represents an event flowing through the system with resilient delivery guarantees.
 *
 * @typeParam T - The shape of the payload associated with the event.
 */
export type EventMessage<T = any> = {

    /**
     * The message ID used in AMQP (optional, but helpful for tracing).
     */
    messageId: string;

    /**
     * The logical event type (e.g., 'order.created', 'user.deleted').
     */
    type?: string;

    /**
     * The actual data payload of the event.
     */
    payload: T;

    /**
     * The current lifecycle status of the event (internal use, managed by the library).
     */
    status?: string;

    /**
     * Optional routing key for publishing to an exchange. When present, the publisher
     * will use this routing key for exchange-based publishes. If omitted, no routing
     * key will be used (empty string will be passed to the broker where required).
     */
    routingKey?: string;

    /**
     * Additional message properties relevant to AMQP delivery.
     */
    properties?: EventProperties;
};
