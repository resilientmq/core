import { ResilientConsumer } from '../../src/resilience/resilient-consumer';
import { ResilientEventPublisher } from '../../src/resilience/resilient-event-publisher';
import { TestContainersManager } from '../utils/test-containers';
import { EventStoreMock } from '../utils/event-store-mock';
import { EventBuilder, ConsumerConfigBuilder, PublisherConfigBuilder } from '../utils/test-data-builders';
import { EventConsumeStatus } from '../../src/types/enum/event-consume-status';
import { RabbitMQHelpers } from '../utils/rabbitmq-helpers';

describe('Integration: Consumer-Publisher Flow', () => {
    let containerManager: TestContainersManager;
    let connectionUrl: string;
    let consumer: ResilientConsumer;
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

    let publisherStore: EventStoreMock;

    afterEach(async () => {
        if (consumer) {
            try {
                // Stop consumer gracefully
                await (consumer as any).queue?.disconnect();
            } catch (error) {
                // Ignore cleanup errors
            }
        }
        if (publisher) {
            try {
                publisher.stopPendingEventsCheck();
            } catch (error) {
                // Ignore cleanup errors
            }
        }
        store.clear();
        if (publisherStore) {
            publisherStore.clear();
        }
    });

    it('should publish and consume event end-to-end', async () => {
        // Arrange
        const testPayload = { userId: 123, action: 'test' };
        const event = new EventBuilder()
            .withType('user.created')
            .withPayload(testPayload)
            .build();

        let receivedPayload: any = null;
        let handlerCalled = false;

        const consumerConfig = new ConsumerConfigBuilder()
            .withConnection(connectionUrl)
            .withQueue('test.integration.queue')
            .withStore(store)
            .withEventHandler('user.created', async (event) => {
                receivedPayload = event.payload;
                handlerCalled = true;
            })
            .withPrefetch(1)
            .build();

        consumer = new ResilientConsumer(consumerConfig);

        // Use separate store for publisher to avoid duplicate detection issues
        publisherStore = new EventStoreMock();
        
        const publisherConfig = new PublisherConfigBuilder()
            .withConnection(connectionUrl)
            .withQueue('test.integration.queue')
            .withStore(publisherStore)
            .withInstantPublish(true)
            .build();

        publisher = new ResilientEventPublisher(publisherConfig);

        // Act
        await consumer.start();
        
        // Wait a bit for consumer to be ready
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        await publisher.publish(event);

        // Wait for message to be processed
        await new Promise(resolve => setTimeout(resolve, 3000));

        // Assert
        expect(handlerCalled).toBe(true);
        expect(receivedPayload).toEqual(testPayload);

        // Verify event was saved in store
        const storedEvent = await store.getEvent(event);
        expect(storedEvent).not.toBeNull();
        
        // After processing, the consumer updates status to DONE
        expect(storedEvent?.status).toBe(EventConsumeStatus.DONE);
    }, 30000);
});
