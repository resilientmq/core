import {
    ClaimedPublishEvent,
    ConsumeClaimRequest,
    ConsumeClaimResult,
    ConsumeTransitionRequest,
    EventStore,
    PublishClaimRequest,
    PublishEventClaimRequest,
    PublishTransitionRequest
} from '../../src/types/resilience/event-store';
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
    private failOnGetByStatus: boolean = false;
    private consumeClaims = new Map<string, {token: string; instanceId: string; expiresAt: number}>();
    private publishClaims = new Map<string, {token: string; instanceId: string; expiresAt: number}>();
    private nextPublishAttempt = new Map<string, number>();
    private tokenSequence = 0;

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

    /**
     * Simulates failures on getEventsByStatus calls.
     * @param fail If true, getEventsByStatus will throw an error
     */
    setFailOnGetByStatus(fail: boolean): void {
        this.failOnGetByStatus = fail;
    }

    async saveEvent(event: EventMessage): Promise<void> {
        this.incrementCallCount('saveEvent');

        if (this.failOnSave) {
            throw new Error('EventStore: saveEvent failed (simulated)');
        }

        this.events.set(event.messageId, { ...event });
    }

    async saveEventIfNotExists(event: EventMessage): Promise<boolean> {
        this.incrementCallCount('saveEventIfNotExists');

        if (this.failOnSave) {
            throw new Error('EventStore: saveEventIfNotExists failed (simulated)');
        }

        if (this.events.has(event.messageId)) {
            return false;
        }

        this.events.set(event.messageId, { ...event });
        return true;
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

    async getEventsByStatus(
        status: EventConsumeStatus | EventPublishStatus
    ): Promise<EventMessage[]> {
        this.incrementCallCount('getEventsByStatus');

        if (this.failOnGetByStatus) {
            throw new Error('EventStore: getEventsByStatus failed (simulated)');
        }

        const matchingEvents: EventMessage[] = [];
        for (const event of this.events.values()) {
            if (event.status === status) {
                matchingEvents.push({ ...event });
            }
        }

        return matchingEvents;
    }

    async batchUpdateEventStatus(
        updates: Array<{ event: EventMessage; status: EventConsumeStatus | EventPublishStatus }>
    ): Promise<void> {
        this.incrementCallCount('batchUpdateEventStatus');

        if (this.failOnUpdate) {
            throw new Error('EventStore: batchUpdateEventStatus failed (simulated)');
        }

        for (const { event, status } of updates) {
            const existingEvent = this.events.get(event.messageId);
            if (existingEvent) {
                existingEvent.status = status;
            }
        }
    }

    async claimConsumeEvent(request: ConsumeClaimRequest): Promise<ConsumeClaimResult> {
        this.incrementCallCount('claimConsumeEvent');
        const id = request.event.messageId;
        const existing = this.events.get(id);
        if (existing?.status === EventConsumeStatus.DONE || existing?.status === EventConsumeStatus.ERROR) {
            return {outcome: 'completed'};
        }
        const current = this.consumeClaims.get(id);
        if (current && current.expiresAt > request.now) {
            return {outcome: 'busy', leaseExpiresAt: current.expiresAt};
        }
        const token = `consume-${++this.tokenSequence}`;
        const expiresAt = request.now + request.leaseDurationMs;
        this.consumeClaims.set(id, {token, instanceId: request.instanceId, expiresAt});
        this.events.set(id, {...request.event, status: EventConsumeStatus.PROCESSING});
        return {outcome: 'acquired', fencingToken: token, leaseExpiresAt: expiresAt};
    }

    async transitionConsumeEvent(request: ConsumeTransitionRequest): Promise<boolean> {
        this.incrementCallCount('transitionConsumeEvent');
        if (this.failOnUpdate) throw new Error('EventStore: transitionConsumeEvent failed (simulated)');
        const claim = this.consumeClaims.get(request.event.messageId);
        if (!claim || claim.token !== request.fencingToken || claim.instanceId !== request.instanceId) return false;
        const event = this.events.get(request.event.messageId) ?? request.event;
        this.events.set(request.event.messageId, {...event, status: request.status});
        this.consumeClaims.delete(request.event.messageId);
        return true;
    }

    async claimPendingEvents(request: PublishClaimRequest): Promise<ClaimedPublishEvent[]> {
        this.incrementCallCount('claimPendingEvents');
        if (this.failOnGetPending) throw new Error('EventStore: claimPendingEvents failed (simulated)');
        const claimed: ClaimedPublishEvent[] = [];
        for (const event of this.events.values()) {
            if (claimed.length >= request.limit) break;
            if (event.status !== EventPublishStatus.PENDING) continue;
            if ((this.nextPublishAttempt.get(event.messageId) ?? 0) > request.now) continue;
            const current = this.publishClaims.get(event.messageId);
            if (current && current.expiresAt > request.now) continue;
            const claim = this.createPublishClaim(event, request.instanceId, request.now, request.leaseDurationMs);
            claimed.push(claim);
        }
        return claimed;
    }

    async claimPublishEvent(request: PublishEventClaimRequest): Promise<ClaimedPublishEvent | null> {
        this.incrementCallCount('claimPublishEvent');
        const event = this.events.get(request.event.messageId);
        if (!event || event.status !== EventPublishStatus.PENDING) return null;
        if ((this.nextPublishAttempt.get(event.messageId) ?? 0) > request.now) return null;
        const current = this.publishClaims.get(event.messageId);
        if (current && current.expiresAt > request.now) return null;
        return this.createPublishClaim(event, request.instanceId, request.now, request.leaseDurationMs);
    }

    async completePublishedEvent(request: PublishTransitionRequest): Promise<boolean> {
        this.incrementCallCount('completePublishedEvent');
        if (this.failOnUpdate) throw new Error('EventStore: completePublishedEvent failed (simulated)');
        const claim = this.publishClaims.get(request.event.messageId);
        if (!claim || claim.token !== request.fencingToken || claim.instanceId !== request.instanceId) return false;
        const event = this.events.get(request.event.messageId) ?? request.event;
        this.events.set(request.event.messageId, {...event, status: EventPublishStatus.PUBLISHED});
        this.publishClaims.delete(request.event.messageId);
        this.nextPublishAttempt.delete(request.event.messageId);
        return true;
    }

    async releasePublishEvent(request: PublishTransitionRequest): Promise<boolean> {
        this.incrementCallCount('releasePublishEvent');
        const claim = this.publishClaims.get(request.event.messageId);
        if (!claim || claim.token !== request.fencingToken || claim.instanceId !== request.instanceId) return false;
        const event = this.events.get(request.event.messageId) ?? request.event;
        this.events.set(request.event.messageId, {...event, status: EventPublishStatus.PENDING});
        this.publishClaims.delete(request.event.messageId);
        this.nextPublishAttempt.set(request.event.messageId, request.nextAttemptAt ?? request.now);
        return true;
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
        this.failOnGetByStatus = false;
        this.consumeClaims.clear();
        this.publishClaims.clear();
        this.nextPublishAttempt.clear();
        this.tokenSequence = 0;
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

    private createPublishClaim(
        event: EventMessage,
        instanceId: string,
        now: number,
        leaseDurationMs: number
    ): ClaimedPublishEvent {
        const token = `publish-${++this.tokenSequence}`;
        const leaseExpiresAt = now + leaseDurationMs;
        this.publishClaims.set(event.messageId, {token, instanceId, expiresAt: leaseExpiresAt});
        return {event: {...event}, fencingToken: token, leaseExpiresAt};
    }
}
