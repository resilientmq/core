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
     * Retrieves all pending events with the specified status.
     *
     * @param status - The status to filter events by (e.g., PENDING).
     * @returns Array of pending events. Order is handled by the publisher.
     */
    getPendingEvents(status: EventPublishStatus): Promise<EventMessage[]>;
}
