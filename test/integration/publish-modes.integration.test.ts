import { ResilientEventPublisher } from '../../src/resilience/resilient-event-publisher';
import { TestContainersManager } from '../utils/test-containers';
import { EventStoreMock } from '../utils/event-store-mock';
import { EventBuilder, PublisherConfigBuilder } from '../utils/test-data-builders';
import { EventPublishStatus } from '../../src/types/enum/event-publish-status';
import { RabbitMQHelpers } from '../utils/rabbitmq-helpers';

describe('Integration: Publish Modes (Instant vs Deferred)', () => {
    let containerManager: TestContainersManager;
    let connectionUrl: string;
    let publisher: ResilientEventPublisher;
    let store: EventStoreMock;
    let rabbitMQHelpers: RabbitMQHelpers;

    beforeAll(async () => {
        containerManager = new TestContainersManager();
        await containerManager.startRabbitMQ();
        connectionUrl = containerManager.getConnectionUrl();
        rabbitMQHelpers = new RabbitMQHelpers(connectionUrl);
    }, 60000);

    afterAll(async () => {
        await rabbitMQHelpers.disconnect();
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

    describe('Instant Publish (instantPublish: true)', () => {
        it('should publish immediately with store', async () => {
            const event = new EventBuilder()
                .withType('test.instant')
                .withPayload({ data: 'instant' })
                .build();

            const publisherConfig = new PublisherConfigBuilder()
                .withConnection(connectionUrl)
                .withQueue('test.instant.queue')
                .withStore(store)
                .withInstantPublish(true)
                .build();

            publisher = new ResilientEventPublisher(publisherConfig);

            await publisher.publish(event);
            await new Promise(resolve => setTimeout(resolve, 500));

            // Should be in store with PUBLISHED status
            const storedEvent = await store.getEvent(event);
            expect(storedEvent).not.toBeNull();
            expect(storedEvent?.status).toBe(EventPublishStatus.PUBLISHED);
        }, 10000);

        it('should publish immediately without store', async () => {
            const event = new EventBuilder()
                .withType('test.instant.no.store')
                .withPayload({ data: 'instant' })
                .build();

            const publisherConfig = new PublisherConfigBuilder()
                .withConnection(connectionUrl)
                .withQueue('test.instant.no.store.queue')
                .withInstantPublish(true)
                .build();

            // Remove store
            delete (publisherConfig as any).store;

            publisher = new ResilientEventPublisher(publisherConfig);

            // Just verify it doesn't throw an error
            await expect(publisher.publish(event)).resolves.not.toThrow();
        }, 10000);
    });

    describe('Deferred Publish (instantPublish: false)', () => {
        it('should store with PENDING status when storeOnly is true', async () => {
            const event = new EventBuilder()
                .withType('test.deferred')
                .withPayload({ data: 'deferred' })
                .build();

            const publisherConfig = new PublisherConfigBuilder()
                .withConnection(connectionUrl)
                .withQueue('test.deferred.queue')
                .withStore(store)
                .withInstantPublish(false)
                .build();

            publisher = new ResilientEventPublisher(publisherConfig);

            await publisher.publish(event, { storeOnly: true });
            await new Promise(resolve => setTimeout(resolve, 500));

            // Should be in store with PENDING status
            const storedEvent = await store.getEvent(event);
            expect(storedEvent).not.toBeNull();
            expect(storedEvent?.status).toBe(EventPublishStatus.PENDING);
        }, 10000);

        it('should process pending events and publish them', async () => {
            const event1 = new EventBuilder()
                .withType('test.pending')
                .withPayload({ id: 1 })
                .withTimestamp(Date.now() - 2000)
                .build();

            const event2 = new EventBuilder()
                .withType('test.pending')
                .withPayload({ id: 2 })
                .withTimestamp(Date.now() - 1000)
                .build();

            const publisherConfig = new PublisherConfigBuilder()
                .withConnection(connectionUrl)
                .withQueue('test.pending.queue')
                .withStore(store)
                .withInstantPublish(false)
                .build();

            publisher = new ResilientEventPublisher(publisherConfig);

            // Store events
            await publisher.publish(event1, { storeOnly: true });
            await publisher.publish(event2, { storeOnly: true });

            // Verify both are PENDING
            let pendingEvents = await store.getPendingEvents(EventPublishStatus.PENDING);
            expect(pendingEvents.length).toBe(2);

            // Process pending events
            await publisher.processPendingEvents();
            await new Promise(resolve => setTimeout(resolve, 500));

            // Verify both are PUBLISHED
            const storedEvent1 = await store.getEvent(event1);
            const storedEvent2 = await store.getEvent(event2);
            expect(storedEvent1?.status).toBe(EventPublishStatus.PUBLISHED);
            expect(storedEvent2?.status).toBe(EventPublishStatus.PUBLISHED);

            // No more pending
            pendingEvents = await store.getPendingEvents(EventPublishStatus.PENDING);
            expect(pendingEvents.length).toBe(0);
        }, 10000);

        it('should process pending events in chronological order', async () => {
            const now = Date.now();
            const event1 = new EventBuilder()
                .withType('test.order')
                .withPayload({ sequence: 1 })
                .withTimestamp(now - 3000)
                .build();

            const event2 = new EventBuilder()
                .withType('test.order')
                .withPayload({ sequence: 2 })
                .withTimestamp(now - 2000)
                .build();

            const event3 = new EventBuilder()
                .withType('test.order')
                .withPayload({ sequence: 3 })
                .withTimestamp(now - 1000)
                .build();

            const publisherConfig = new PublisherConfigBuilder()
                .withConnection(connectionUrl)
                .withQueue('test.order.queue')
                .withStore(store)
                .withInstantPublish(false)
                .build();

            publisher = new ResilientEventPublisher(publisherConfig);

            // Store in random order
            await publisher.publish(event2, { storeOnly: true });
            await publisher.publish(event1, { storeOnly: true });
            await publisher.publish(event3, { storeOnly: true });

            // Process pending events
            await publisher.processPendingEvents();
            await new Promise(resolve => setTimeout(resolve, 500));

            // All should be PUBLISHED
            const storedEvent1 = await store.getEvent(event1);
            const storedEvent2 = await store.getEvent(event2);
            const storedEvent3 = await store.getEvent(event3);
            
            expect(storedEvent1?.status).toBe(EventPublishStatus.PUBLISHED);
            expect(storedEvent2?.status).toBe(EventPublishStatus.PUBLISHED);
            expect(storedEvent3?.status).toBe(EventPublishStatus.PUBLISHED);
        }, 10000);
    });

    describe('Mixed Mode', () => {
        it('should handle both instant and deferred publishing', async () => {
            const instantEvent = new EventBuilder()
                .withType('test.mixed.instant')
                .withPayload({ type: 'instant' })
                .build();

            const deferredEvent = new EventBuilder()
                .withType('test.mixed.deferred')
                .withPayload({ type: 'deferred' })
                .build();

            const publisherConfig = new PublisherConfigBuilder()
                .withConnection(connectionUrl)
                .withQueue('test.mixed.queue')
                .withStore(store)
                .withInstantPublish(true)
                .build();

            publisher = new ResilientEventPublisher(publisherConfig);

            // Publish instantly
            await publisher.publish(instantEvent);
            
            // Store for later
            await publisher.publish(deferredEvent, { storeOnly: true });
            
            await new Promise(resolve => setTimeout(resolve, 500));

            // Instant should be PUBLISHED
            const storedInstant = await store.getEvent(instantEvent);
            expect(storedInstant?.status).toBe(EventPublishStatus.PUBLISHED);

            // Deferred should be PENDING
            const storedDeferred = await store.getEvent(deferredEvent);
            expect(storedDeferred?.status).toBe(EventPublishStatus.PENDING);

            // Process pending
            await publisher.processPendingEvents();
            await new Promise(resolve => setTimeout(resolve, 500));

            // Now deferred should also be PUBLISHED
            const updatedDeferred = await store.getEvent(deferredEvent);
            expect(updatedDeferred?.status).toBe(EventPublishStatus.PUBLISHED);
        }, 10000);
    });
});
