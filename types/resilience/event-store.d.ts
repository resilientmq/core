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
     * @param messageId - The message's unique ID.
     * @param status - The new status to assign to the event.
     */
    updateEventStatus(
        messageId: string,
        status: EventConsumeStatus | EventPublishStatus
    ): Promise<void>;

    /**
     * Fetches an event based on its message ID.
     *
     * @param messageId - The ID of the event to retrieve.
     * @returns The found event or `null`.
     */
    getEvent(messageId: string): Promise<EventMessage | null>;

    /**
     * Deletes a previously stored event by message ID.
     *
     * @param messageId - The ID of the event to delete.
     */
    deleteEvent(messageId: string): Promise<void>;
}
