import type {EventMessage} from './event-message';
import {EventConsumeStatus} from '../enum/event-consume-status';
import {EventPublishStatus} from '../enum/event-publish-status';

/** Identifies a stable service and one ephemeral process replica. */
export interface LeaseOwner {
    /** Stable hash shared by every replica of one logical service. */
    serviceId: string;

    /** Unique identifier generated for the current process. */
    instanceId: string;
}

/** Requests an atomic inbox lease for one delivery. */
export interface ConsumeClaimRequest extends LeaseOwner {
    /** Event being claimed. */
    event: EventMessage;

    /** Current RabbitMQ delivery attempt. */
    attempt: number;

    /** Duration after which another process may recover the claim. */
    leaseDurationMs: number;

    /** Current Unix time in milliseconds. */
    now: number;
}

/** Result of an atomic inbox claim. */
export type ConsumeClaimResult =
    | {outcome: 'completed'}
    | {outcome: 'busy'; leaseExpiresAt: number}
    | {outcome: 'acquired'; fencingToken: string | number; leaseExpiresAt: number};

/** Applies a fenced transition to an acquired inbox event. */
export interface ConsumeTransitionRequest extends LeaseOwner {
    /** Event whose lease is being transitioned. */
    event: EventMessage;

    /** Token returned by the atomic claim. */
    fencingToken: string | number;

    /** Target terminal or retry status. */
    status: EventConsumeStatus.DONE | EventConsumeStatus.RETRY | EventConsumeStatus.ERROR;

    /** Current Unix time in milliseconds. */
    now: number;

    /** Error associated with a failed attempt. */
    error?: Error;
}

/** Requests a batch of exclusively leased outbox events. */
export interface PublishClaimRequest extends LeaseOwner {
    /** Maximum events to claim. */
    limit: number;

    /** Duration after which another process may recover each claim. */
    leaseDurationMs: number;

    /** Current Unix time in milliseconds. */
    now: number;
}

/** Requests an exclusive outbox lease for one known event. */
export interface PublishEventClaimRequest extends LeaseOwner {
    /** Event to claim. */
    event: EventMessage;

    /** Duration after which another process may recover the claim. */
    leaseDurationMs: number;

    /** Current Unix time in milliseconds. */
    now: number;
}

/** Outbox event protected by a fencing token. */
export interface ClaimedPublishEvent {
    /** Claimed event. */
    event: EventMessage;

    /** Token required to complete or release the claim. */
    fencingToken: string | number;

    /** Unix time in milliseconds when the claim expires. */
    leaseExpiresAt: number;
}

/** Applies a fenced transition to a claimed outbox event. */
export interface PublishTransitionRequest extends LeaseOwner {
    /** Claimed event. */
    event: EventMessage;

    /** Token returned by the outbox claim. */
    fencingToken: string | number;

    /** Current Unix time in milliseconds. */
    now: number;

    /** Earliest time at which a failed publication may be claimed again. */
    nextAttemptAt?: number;

    /** Publication error when releasing a claim. */
    error?: Error;
}

/** Persistence contract for inbox deduplication and transactional outbox delivery. */
export interface EventStore {
    /** Persists an event. */
    saveEvent(event: EventMessage): Promise<void>;

    /** Persists an event only when its identity does not already exist. */
    saveEventIfNotExists?(event: EventMessage): Promise<boolean>;

    /** Updates an event status for compatibility with stores without lease support. */
    updateEventStatus(
        event: EventMessage,
        status: EventConsumeStatus | EventPublishStatus
    ): Promise<void>;

    /** Retrieves an event by its store-defined identity. */
    getEvent(event: EventMessage): Promise<EventMessage | null>;

    /** Deletes an event by its store-defined identity. */
    deleteEvent(event: EventMessage): Promise<void>;

    /** Retrieves pending events for compatibility with single-worker outboxes. */
    getPendingEvents?(status: EventPublishStatus, limit?: number): Promise<EventMessage[]>;

    /** Retrieves events by status for compatibility with existing stores. */
    getEventsByStatus?(status: EventConsumeStatus | EventPublishStatus): Promise<EventMessage[]>;

    /** Updates multiple statuses for compatibility with existing stores. */
    batchUpdateEventStatus?(
        updates: Array<{event: EventMessage; status: EventConsumeStatus | EventPublishStatus}>
    ): Promise<void>;

    /** Atomically acquires or recovers an inbox processing lease. */
    claimConsumeEvent?(request: ConsumeClaimRequest): Promise<ConsumeClaimResult>;

    /** Applies a terminal or retry status only when the fencing token still owns the lease. */
    transitionConsumeEvent?(request: ConsumeTransitionRequest): Promise<boolean>;

    /** Atomically claims pending or expired outbox events across every replica. */
    claimPendingEvents?(request: PublishClaimRequest): Promise<ClaimedPublishEvent[]>;

    /** Atomically claims one known pending or expired outbox event. */
    claimPublishEvent?(request: PublishEventClaimRequest): Promise<ClaimedPublishEvent | null>;

    /** Marks a confirmed publication complete when the fencing token still owns it. */
    completePublishedEvent?(request: PublishTransitionRequest): Promise<boolean>;

    /** Releases a failed publication for a later claim when the fencing token still owns it. */
    releasePublishEvent?(request: PublishTransitionRequest): Promise<boolean>;
}

/** Store contract required for fenced multi-replica inbox processing. */
export type ConsumerEventStore = EventStore & Required<Pick<
    EventStore,
    'claimConsumeEvent' | 'transitionConsumeEvent'
>>;

/** Store contract required for idempotent enqueue and fenced outbox publication. */
export type PublisherEventStore = EventStore & Required<Pick<
    EventStore,
    'saveEventIfNotExists' | 'claimPublishEvent' | 'completePublishedEvent' | 'releasePublishEvent'
>>;

/** Store contract required for distributed deferred outbox processing. */
export type DistributedPublisherEventStore = PublisherEventStore & Required<Pick<
    EventStore,
    'claimPendingEvents'
>>;
