import type { EventMessage } from './event-message';
import { EventConsumeStatus } from '../enum/event-consume-status';
import { EventPublishStatus } from '../enum/event-publish-status';

/**
 * Defines a persistence contract for storing event states.
 * Used to track event lifecycle during publishing or consuming.
 */
export interface EventStore {
    /**
     * Persists a new event instance into the store.
     *
     * @param event - The event message to store.
     */
    saveEvent(event: EventMessage): Promise<void>;

    /**
     * Updates the status of an event, such as marking it as `DONE` or `RETRY`.
     *
     * @param event - The event message containing the ID to search for.
     * @param status - The new status to assign to the event.
     */
    updateEventStatus(
        event: EventMessage,
        status: EventConsumeStatus | EventPublishStatus
    ): Promise<void>;

    /**
     * Fetches an event based on its message.
     *
     * @param event - The event message containing the ID to search for.
     * @returns The found event or `null`.
     */
    getEvent(event: EventMessage): Promise<EventMessage | null>;

    /**
     * Deletes a previously stored event by message.
     *
     * @param event - The event message containing the ID to search for.
     */
    deleteEvent(event: EventMessage): Promise<void>;

    /**
     * Retrieves pending events with the specified status.
     * This method is optional, but REQUIRED when using ResilientEventPublisher
     * with instantPublish set to false.
     *
     * @param status - The status to filter events by (e.g., PENDING).
     * @param limit - Optional maximum number of events to retrieve per batch.
     *               When provided, only up to `limit` events are returned,
     *               enabling paginated processing to avoid memory issues.
     * @returns Array of pending events. Order is handled by the publisher.
     */
    getPendingEvents?(status: EventPublishStatus, limit?: number): Promise<EventMessage[]>;

    /**
     * Retrieves all events with the specified status.
     * This method is optional. When implemented, it is used by ResilientConsumer
     * during graceful shutdown to find events in RETRY state and revert them to ERROR.
     *
     * @param status - The status to filter events by (e.g., RETRY).
     * @returns Array of events matching the given status.
     */
    getEventsByStatus?(status: EventConsumeStatus | EventPublishStatus): Promise<EventMessage[]>;

    /**
     * Updates the status of multiple events in a single batch operation.
     * This method is optional but highly recommended for performance when processing
     * large numbers of events. When not implemented, falls back to individual updates.
     *
     * @param updates - Array of event-status pairs to update.
     * @returns Promise that resolves when all updates are complete.
     */
    batchUpdateEventStatus?(
        updates: Array<{ event: EventMessage; status: EventConsumeStatus | EventPublishStatus }>
    ): Promise<void>;
}
