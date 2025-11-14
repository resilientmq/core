import { ResilientConsumer } from '../../src/resilience/resilient-consumer';
import { ResilientEventPublisher } from '../../src/resilience/resilient-event-publisher';
import { TestContainersManager } from '../utils/test-containers';
import { EventStoreMock } from '../utils/event-store-mock';
import { EventBuilder, ConsumerConfigBuilder, PublisherConfigBuilder } from '../utils/test-data-builders';
import { EventConsumeStatus } from '../../src/types/enum/event-consume-status';
import { RabbitMQHelpers } from '../utils/rabbitmq-helpers';

describe('Integration: Dead Letter Queue Flow', () => {
    let containerManager: TestContainersManager;
    let connectionUrl: string;
    let consumer: ResilientConsumer;
    let publisher: ResilientEventPublisher;
    let store: EventStoreMock;
    let publisherStore: EventStoreMock;
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
        if (consumer) {
            try {
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

    it('should handle persistent failures', async () => {
        // Arrange
        const testPayload = { userId: 999, action: 'dlq-test' };
        const event = new EventBuilder()
            .withType('notification.send')
            .withPayload(testPayload)
            .build();

        let attemptCount = 0;

        const consumerConfig = new ConsumerConfigBuilder()
            .withConnection(connectionUrl)
            .withQueue('test.dlq.simple.queue')
            .withStore(store)
            .withEventHandler('notification.send', async (event) => {
                attemptCount++;
                // Always fail
                throw new Error('Simulated persistent failure');
            })
            .build();

        consumer = new ResilientConsumer(consumerConfig);

        publisherStore = new EventStoreMock();
        const publisherConfig = new PublisherConfigBuilder()
            .withConnection(connectionUrl)
            .withQueue('test.dlq.simple.queue')
            .withStore(publisherStore)
            .withInstantPublish(true)
            .build();

        publisher = new ResilientEventPublisher(publisherConfig);

        // Act
        await consumer.start();
        
        // Wait for consumer to be ready
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        await publisher.publish(event);

        // Wait for processing
        await new Promise(resolve => setTimeout(resolve, 3000));

        // Assert
        expect(attemptCount).toBeGreaterThanOrEqual(1); // Should have tried at least once

        // Verify event was attempted
        const storedEvent = await store.getEvent(event);
        expect(storedEvent).not.toBeNull();
    }, 30000);

    it('should process successful messages', async () => {
        // Arrange
        const testPayload = { orderId: 12345 };
        const event = new EventBuilder()
            .withType('order.success')
            .withPayload(testPayload)
            .build();

        let handlerCalled = false;

        const consumerConfig = new ConsumerConfigBuilder()
            .withConnection(connectionUrl)
            .withQueue('test.success.simple.queue')
            .withStore(store)
            .withEventHandler('order.success', async (event) => {
                handlerCalled = true;
                // Success
            })
            .build();

        consumer = new ResilientConsumer(consumerConfig);

        publisherStore = new EventStoreMock();
        const publisherConfig = new PublisherConfigBuilder()
            .withConnection(connectionUrl)
            .withQueue('test.success.simple.queue')
            .withStore(publisherStore)
            .withInstantPublish(true)
            .build();

        publisher = new ResilientEventPublisher(publisherConfig);

        // Act
        await consumer.start();
        
        // Wait for consumer to be ready
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        await publisher.publish(event);

        // Wait for processing
        await new Promise(resolve => setTimeout(resolve, 3000));

        // Assert
        expect(handlerCalled).toBe(true);
        const storedEvent = await store.getEvent(event);
        expect(storedEvent).not.toBeNull();
        expect(storedEvent?.status).toBe(EventConsumeStatus.DONE);
    }, 30000);
});
