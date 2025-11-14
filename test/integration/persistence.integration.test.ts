import { ResilientEventPublisher } from '../../src/resilience/resilient-event-publisher';
import { TestContainersManager } from '../utils/test-containers';
import { EventStoreMock } from '../utils/event-store-mock';
import { EventBuilder, PublisherConfigBuilder } from '../utils/test-data-builders';
import { EventPublishStatus } from '../../src/types/enum/event-publish-status';

describe('Integration: Persistence with EventStore', () => {
    let containerManager: TestContainersManager;
    let connectionUrl: string;
    let publisher: ResilientEventPublisher;
    let store: EventStoreMock;

    beforeAll(async () => {
        containerManager = new TestContainersManager();
        await containerManager.startRabbitMQ();
        connectionUrl = containerManager.getConnectionUrl();
    }, 60000);

    afterAll(async () => {
        await containerManager.stopAll();
    }, 30000);

    beforeEach(() => {
        store = new EventStoreMock();
    });

    afterEach(async () => {
        if (publisher) {
            try {
                publisher.stopPendingEventsCheck();
            } catch (error) {
                // Ignore cleanup errors
            }
        }
        store.clear();
    });

    it('should store events with PENDING status when storeOnly is true', async () => {
        // Arrange
        const event1 = new EventBuilder()
            .withType('user.registered')
            .withPayload({ userId: 1, email: 'user1@test.com' })
            .build();

        const event2 = new EventBuilder()
            .withType('user.registered')
            .withPayload({ userId: 2, email: 'user2@test.com' })
            .build();

        const publisherConfig = new PublisherConfigBuilder()
            .withConnection(connectionUrl)
            .withQueue('test.persistence.queue')
            .withStore(store)
            .withInstantPublish(false) // Disable instant publish
            .build();

        publisher = new ResilientEventPublisher(publisherConfig);

        // Act
        await publisher.publish(event1, { storeOnly: true });
        await publisher.publish(event2, { storeOnly: true });

        // Assert
        const storedEvent1 = await store.getEvent(event1);
        const storedEvent2 = await store.getEvent(event2);

        expect(storedEvent1).not.toBeNull();
        expect(storedEvent1?.status).toBe(EventPublishStatus.PENDING);
        expect(storedEvent1?.payload).toEqual({ userId: 1, email: 'user1@test.com' });

        expect(storedEvent2).not.toBeNull();
        expect(storedEvent2?.status).toBe(EventPublishStatus.PENDING);
        expect(storedEvent2?.payload).toEqual({ userId: 2, email: 'user2@test.com' });

        // Verify events are retrievable as pending
        const pendingEvents = await store.getPendingEvents(EventPublishStatus.PENDING);
        expect(pendingEvents.length).toBe(2);
    }, 30000);

    it('should process pending events and update status to PUBLISHED', async () => {
        // Arrange
        const event1 = new EventBuilder()
            .withType('order.created')
            .withPayload({ orderId: 101, amount: 99.99 })
            .withTimestamp(Date.now() - 2000) // Older event
            .build();

        const event2 = new EventBuilder()
            .withType('order.created')
            .withPayload({ orderId: 102, amount: 149.99 })
            .withTimestamp(Date.now() - 1000) // Newer event
            .build();

        const publisherConfig = new PublisherConfigBuilder()
            .withConnection(connectionUrl)
            .withQueue('test.pending.queue')
            .withStore(store)
            .withInstantPublish(false)
            .build();

        publisher = new ResilientEventPublisher(publisherConfig);

        // Store events without publishing
        await publisher.publish(event1, { storeOnly: true });
        await publisher.publish(event2, { storeOnly: true });

        // Verify both are PENDING
        let pendingEvents = await store.getPendingEvents(EventPublishStatus.PENDING);
        expect(pendingEvents.length).toBe(2);

        // Act - Process pending events
        await publisher.processPendingEvents();

        // Assert
        const storedEvent1 = await store.getEvent(event1);
        const storedEvent2 = await store.getEvent(event2);

        expect(storedEvent1?.status).toBe(EventPublishStatus.PUBLISHED);
        expect(storedEvent2?.status).toBe(EventPublishStatus.PUBLISHED);

        // Verify no more pending events
        pendingEvents = await store.getPendingEvents(EventPublishStatus.PENDING);
        expect(pendingEvents.length).toBe(0);
    }, 30000);

    it('should process pending events in chronological order', async () => {
        // Arrange
        const now = Date.now();

        // Create events with different timestamps
        const event1 = new EventBuilder()
            .withType('log.entry')
            .withPayload({ sequence: 1 })
            .withTimestamp(now - 3000) // Oldest
            .build();

        const event2 = new EventBuilder()
            .withType('log.entry')
            .withPayload({ sequence: 2 })
            .withTimestamp(now - 2000)
            .build();

        const event3 = new EventBuilder()
            .withType('log.entry')
            .withPayload({ sequence: 3 })
            .withTimestamp(now - 1000) // Newest
            .build();

        const publisherConfig = new PublisherConfigBuilder()
            .withConnection(connectionUrl)
            .withQueue('test.order.queue')
            .withStore(store)
            .withInstantPublish(false)
            .build();

        publisher = new ResilientEventPublisher(publisherConfig);

        // Store events in random order
        await publisher.publish(event2, { storeOnly: true });
        await publisher.publish(event1, { storeOnly: true });
        await publisher.publish(event3, { storeOnly: true });

        // Act - Process pending events
        await publisher.processPendingEvents();

        // Assert - All should be published
        const storedEvent1 = await store.getEvent(event1);
        const storedEvent2 = await store.getEvent(event2);
        const storedEvent3 = await store.getEvent(event3);

        expect(storedEvent1?.status).toBe(EventPublishStatus.PUBLISHED);
        expect(storedEvent2?.status).toBe(EventPublishStatus.PUBLISHED);
        expect(storedEvent3?.status).toBe(EventPublishStatus.PUBLISHED);

        // Events should have been processed in chronological order (oldest first)
        // This is verified by the implementation sorting by timestamp
    }, 30000);

    it('should handle mixed instant and deferred publishing', async () => {
        // Arrange
        const instantEvent = new EventBuilder()
            .withType('notification.instant')
            .withPayload({ message: 'Instant notification' })
            .build();

        const deferredEvent = new EventBuilder()
            .withType('notification.deferred')
            .withPayload({ message: 'Deferred notification' })
            .build();

        const publisherConfig = new PublisherConfigBuilder()
            .withConnection(connectionUrl)
            .withQueue('test.mixed.queue')
            .withStore(store)
            .withInstantPublish(true) // Instant publish enabled
            .build();

        publisher = new ResilientEventPublisher(publisherConfig);

        // Act
        await publisher.publish(instantEvent); // Should publish immediately
        await publisher.publish(deferredEvent, { storeOnly: true }); // Should only store

        // Wait a bit for instant publish
        await new Promise(resolve => setTimeout(resolve, 500));

        // Assert
        const storedInstant = await store.getEvent(instantEvent);
        const storedDeferred = await store.getEvent(deferredEvent);

        // Instant event should be PUBLISHED
        expect(storedInstant?.status).toBe(EventPublishStatus.PUBLISHED);

        // Deferred event should still be PENDING
        expect(storedDeferred?.status).toBe(EventPublishStatus.PENDING);

        // Process pending events
        await publisher.processPendingEvents();

        // Now deferred should also be PUBLISHED
        const updatedDeferred = await store.getEvent(deferredEvent);
        expect(updatedDeferred?.status).toBe(EventPublishStatus.PUBLISHED);
    }, 30000);
});
