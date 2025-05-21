/**
 * Represents the lifecycle status of an event during publishing.
 * Useful for ensuring reliable delivery in a resilient message system.
 */
export enum EventPublishStatus {
    /**
     * The event is queued and waiting to be published.
     */
    PENDING = 'PENDING_PUBLICATION',

    /**
     * The event has been successfully published to the broker.
     */
    PUBLISHED = 'PUBLISHED',

    /**
     * An error occurred while publishing the event to the broker.
     */
    ERROR = 'PUBLICATION_ERROR'
}
