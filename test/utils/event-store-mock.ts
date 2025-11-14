import { EventStore } from '../../src/types/resilience/event-store';
import { EventMessage } from '../../src/types/resilience/event-message';
import { EventConsumeStatus } from '../../src/types/enum/event-consume-status';
import { EventPublishStatus } from '../../src/types/enum/event-publish-status';

/**
 * In-memory mock implementation of EventStore for unit testing.
 * Provides capabilities to simulate failures and track method calls.
 */
export class EventStoreMock implements EventStore {
    private events: Map<string, EventMessage> = new Map();
    private callCounts: Map<string, number> = new Map();
    private failOnSave: boolean = false;
    private failOnUpdate: boolean = false;
    private failOnGet: boolean = false;
    private failOnDelete: boolean = false;
    private failOnGetPending: boolean = false;

    /**
     * Simulates failures on saveEvent calls.
     * @param fail If true, saveEvent will throw an error
     */
    setFailOnSave(fail: boolean): void {
        this.failOnSave = fail;
    }

    /**
     * Simulates failures on updateEventStatus calls.
     * @param fail If true, updateEventStatus will throw an error
     */
    setFailOnUpdate(fail: boolean): void {
        this.failOnUpdate = fail;
    }

    /**
     * Simulates failures on getEvent calls.
     * @param fail If true, getEvent will throw an error
     */
    setFailOnGet(fail: boolean): void {
        this.failOnGet = fail;
    }

    /**
     * Simulates failures on deleteEvent calls.
     * @param fail If true, deleteEvent will throw an error
     */
    setFailOnDelete(fail: boolean): void {
        this.failOnDelete = fail;
    }

    /**
     * Simulates failures on getPendingEvents calls.
     * @param fail If true, getPendingEvents will throw an error
     */
    setFailOnGetPending(fail: boolean): void {
        this.failOnGetPending = fail;
    }

    async saveEvent(event: EventMessage): Promise<void> {
        this.incrementCallCount('saveEvent');

        if (this.failOnSave) {
            throw new Error('EventStore: saveEvent failed (simulated)');
        }

        this.events.set(event.messageId, { ...event });
    }

    async updateEventStatus(
        event: EventMessage,
        status: EventConsumeStatus | EventPublishStatus
    ): Promise<void> {
        this.incrementCallCount('updateEventStatus');

        if (this.failOnUpdate) {
            throw new Error('EventStore: updateEventStatus failed (simulated)');
        }

        const existingEvent = this.events.get(event.messageId);
        if (existingEvent) {
            existingEvent.status = status;
        }
    }

    async getEvent(event: EventMessage): Promise<EventMessage | null> {
        this.incrementCallCount('getEvent');

        if (this.failOnGet) {
            throw new Error('EventStore: getEvent failed (simulated)');
        }

        const storedEvent = this.events.get(event.messageId);
        return storedEvent ? { ...storedEvent } : null;
    }

    async deleteEvent(event: EventMessage): Promise<void> {
        this.incrementCallCount('deleteEvent');

        if (this.failOnDelete) {
            throw new Error('EventStore: deleteEvent failed (simulated)');
        }

        this.events.delete(event.messageId);
    }

    async getPendingEvents(status: EventPublishStatus): Promise<EventMessage[]> {
        this.incrementCallCount('getPendingEvents');

        if (this.failOnGetPending) {
            throw new Error('EventStore: getPendingEvents failed (simulated)');
        }

        const pendingEvents: EventMessage[] = [];
        for (const event of this.events.values()) {
            if (event.status === status) {
                pendingEvents.push({ ...event });
            }
        }

        return pendingEvents;
    }

    /**
     * Clears all stored events and resets call counts.
     * Useful for test cleanup between test cases.
     */
    clear(): void {
        this.events.clear();
        this.callCounts.clear();
        this.failOnSave = false;
        this.failOnUpdate = false;
        this.failOnGet = false;
        this.failOnDelete = false;
        this.failOnGetPending = false;
    }

    /**
     * Gets all events currently stored in the mock.
     * @returns Array of all stored events
     */
    getAllEvents(): EventMessage[] {
        return Array.from(this.events.values()).map(event => ({ ...event }));
    }

    /**
     * Gets the number of times a specific method was called.
     * @param method The method name to check
     * @returns The number of times the method was called
     */
    getCallCount(method: string): number {
        return this.callCounts.get(method) || 0;
    }

    /**
     * Resets all call counts to zero.
     */
    resetCallCounts(): void {
        this.callCounts.clear();
    }

    private incrementCallCount(method: string): void {
        const current = this.callCounts.get(method) || 0;
        this.callCounts.set(method, current + 1);
    }
}
