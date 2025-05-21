/**
 * Represents the lifecycle status of an event during consumption.
 * This is useful for tracking progress, implementing retries, and observability.
 */
export enum EventConsumeStatus {
    /**
     * The event has been received but not yet processed.
     */
    RECEIVED = 'RECEIVED',

    /**
     * The event is currently being handled by a consumer.
     */
    PROCESSING = 'PROCESSING',

    /**
     * The event was successfully handled and completed.
     */
    DONE = 'DONE',

    /**
     * The event failed permanently and will not be retried again.
     */
    ERROR = 'ERROR',

    /**
     * The event failed and is scheduled for a retry (typically via retry queue).
     */
    RETRY = 'RETRY'
}
