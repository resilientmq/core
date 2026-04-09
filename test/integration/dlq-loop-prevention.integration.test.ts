import { ResilientConsumer } from '../../src/resilience/resilient-consumer';
import { ResilientEventPublisher } from '../../src/resilience/resilient-event-publisher';
import { TestContainersManager } from '../utils/test-containers';
import { EventStoreMock } from '../utils/event-store-mock';
import { EventBuilder, ConsumerConfigBuilder, PublisherConfigBuilder } from '../utils/test-data-builders';
import { RabbitMQHelpers } from '../utils/rabbitmq-helpers';
import { uniqueQueueName, TEST_CONFIG } from './test-config';

/**
 * Regression tests for the infinite NACK loop bug in the hard guard path.
 *
 * The hard guard in ResilientEventConsumeProcessor.process() fires when a message
 * arrives with x-retry-count >= maxAttempts (abnormal re-delivery). Before the fix,
 * if sendToDlqOrDiscard() threw an error, it propagated to the consumer → NACK →
 * DLX → retry queue → TTL → back to main queue → hard guard fires again → infinite loop.
 *
 * The fix wraps sendToDlqOrDiscard in a try-catch so that on failure the message is
 * ACKed, breaking the loop.
 */
describe('Integration: DLQ Loop Prevention (hard guard)', () => {
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
        await rabbitMQHelpers?.disconnect?.();
        await containerManager.stopAll();
    }, 30000);

    beforeEach(() => {
        store = new EventStoreMock();
        publisherStore = new EventStoreMock();
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
        store?.clear();
        publisherStore?.clear();
    });

    it('should ACK message (not loop) when sendToDlqOrDiscard fails in hard guard', async () => {
        // Arrange
        const queueName = uniqueQueueName('test.loop-prevention');
        const retryQueueName = `${queueName}.retry`;
        const dlqName = `${queueName}.dlq`;
        const maxAttempts = 3;

        // Store fails on updateEventStatus → sendToDlqOrDiscard will throw
        // before reaching broker.publish, simulating DB outage during DLQ routing
        store.setFailOnUpdate(true);

        let handlerCallCount = 0;

        const consumerConfig = new ConsumerConfigBuilder()
            .withConnection(connectionUrl)
            .withQueue(queueName)
            .withStore(store)
            .withRetryConfig(retryQueueName, 500, maxAttempts)
            .withDeadLetterQueue(dlqName)
            .withEventHandler('test.loop-event', async () => {
                handlerCallCount++;
            })
            .build();

        consumer = new ResilientConsumer(consumerConfig);
        await consumer.start();
        await new Promise(resolve => setTimeout(resolve, TEST_CONFIG.CONSUMER_READY_DELAY));

        // Publish a message with x-retry-count already at maxAttempts.
        // This simulates a message that bounced back after a failed DLQ routing
        // (the exact scenario that caused 771+ NACK cycles in production).
        const event = new EventBuilder()
            .withType('test.loop-event')
            .withPayload({ test: 'loop-prevention' })
            .withHeaders({ 'x-retry-count': maxAttempts })
            .build();

        const publisherConfig = new PublisherConfigBuilder()
            .withConnection(connectionUrl)
            .withQueue(queueName)
            .withStore(publisherStore)
            .withInstantPublish(true)
            .build();

        publisher = new ResilientEventPublisher(publisherConfig);

        // Act
        await publisher.publish(event);

        // Wait long enough for multiple retry cycles if the message were looping.
        // With 500ms TTL, 5s ≈ 10 potential loop iterations.
        await new Promise(resolve => setTimeout(resolve, 5000));

        // Assert
        // Handler should NEVER be called: hard guard fires before handler execution
        expect(handlerCallCount).toBe(0);

        // All queues must be empty: message was ACKed by the hard guard's catch block
        const mainQueueCount = await rabbitMQHelpers.getMessageCount(queueName);
        const retryQueueCount = await rabbitMQHelpers.getMessageCount(retryQueueName);
        const dlqCount = await rabbitMQHelpers.getMessageCount(dlqName);

        expect(mainQueueCount).toBe(0);
        expect(retryQueueCount).toBe(0);
        expect(dlqCount).toBe(0); // DLQ publish never reached (store threw first)
    }, 30000);

    it('should route to DLQ correctly when hard guard sendToDlqOrDiscard succeeds', async () => {
        // Arrange — positive control: store works, DLQ routing should succeed
        const queueName = uniqueQueueName('test.loop-prevention.dlq-ok');
        const retryQueueName = `${queueName}.retry`;
        const dlqName = `${queueName}.dlq`;
        const maxAttempts = 3;

        let handlerCallCount = 0;

        const consumerConfig = new ConsumerConfigBuilder()
            .withConnection(connectionUrl)
            .withQueue(queueName)
            .withStore(store)
            .withRetryConfig(retryQueueName, 500, maxAttempts)
            .withDeadLetterQueue(dlqName)
            .withEventHandler('test.dlq-ok-event', async () => {
                handlerCallCount++;
            })
            .build();

        consumer = new ResilientConsumer(consumerConfig);
        await consumer.start();
        await new Promise(resolve => setTimeout(resolve, TEST_CONFIG.CONSUMER_READY_DELAY));

        const event = new EventBuilder()
            .withType('test.dlq-ok-event')
            .withPayload({ test: 'dlq-routing-success' })
            .withHeaders({ 'x-retry-count': maxAttempts })
            .build();

        const publisherConfig = new PublisherConfigBuilder()
            .withConnection(connectionUrl)
            .withQueue(queueName)
            .withStore(publisherStore)
            .withInstantPublish(true)
            .build();

        publisher = new ResilientEventPublisher(publisherConfig);

        // Act
        await publisher.publish(event);
        await new Promise(resolve => setTimeout(resolve, 3000));

        // Assert
        // Handler should NOT be called (hard guard fires before handler)
        expect(handlerCallCount).toBe(0);

        // Main and retry queues empty
        const mainQueueCount = await rabbitMQHelpers.getMessageCount(queueName);
        const retryQueueCount = await rabbitMQHelpers.getMessageCount(retryQueueName);
        expect(mainQueueCount).toBe(0);
        expect(retryQueueCount).toBe(0);

        // DLQ should contain the message
        const dlqCount = await rabbitMQHelpers.getMessageCount(dlqName);
        expect(dlqCount).toBe(1);

        // Verify DLQ message has the expected error headers
        const dlqMessages = await rabbitMQHelpers.peekMessages(dlqName, 1);
        expect(dlqMessages.length).toBe(1);
        const headers = dlqMessages[0].properties.headers;
        expect(headers['x-error-message']).toContain('Max retry attempts');
        expect(headers['x-death-count']).toBe(maxAttempts);
    }, 30000);

    it('should not loop when multiple messages hit hard guard with store failure simultaneously', async () => {
        // Arrange — stress scenario: several messages at once, all hitting the hard guard
        const queueName = uniqueQueueName('test.loop-prevention.batch');
        const retryQueueName = `${queueName}.retry`;
        const dlqName = `${queueName}.dlq`;
        const maxAttempts = 3;
        const messageCount = 5;

        store.setFailOnUpdate(true);

        let handlerCallCount = 0;

        const consumerConfig = new ConsumerConfigBuilder()
            .withConnection(connectionUrl)
            .withQueue(queueName)
            .withStore(store)
            .withRetryConfig(retryQueueName, 500, maxAttempts)
            .withDeadLetterQueue(dlqName)
            .withEventHandler('test.batch-loop', async () => {
                handlerCallCount++;
            })
            .build();

        consumer = new ResilientConsumer(consumerConfig);
        await consumer.start();
        await new Promise(resolve => setTimeout(resolve, TEST_CONFIG.CONSUMER_READY_DELAY));

        const publisherConfig = new PublisherConfigBuilder()
            .withConnection(connectionUrl)
            .withQueue(queueName)
            .withStore(publisherStore)
            .withInstantPublish(true)
            .build();

        publisher = new ResilientEventPublisher(publisherConfig);

        // Act — publish multiple messages, all with x-retry-count >= maxAttempts
        for (let i = 0; i < messageCount; i++) {
            const event = new EventBuilder()
                .withType('test.batch-loop')
                .withPayload({ index: i })
                .withHeaders({ 'x-retry-count': maxAttempts })
                .build();
            await publisher.publish(event);
        }

        // Wait for all messages to be processed (or loop if buggy)
        await new Promise(resolve => setTimeout(resolve, 6000));

        // Assert
        expect(handlerCallCount).toBe(0);

        // ALL queues must be empty — every message was ACKed by the hard guard catch
        const mainQueueCount = await rabbitMQHelpers.getMessageCount(queueName);
        const retryQueueCount = await rabbitMQHelpers.getMessageCount(retryQueueName);
        const dlqCount = await rabbitMQHelpers.getMessageCount(dlqName);

        expect(mainQueueCount).toBe(0);
        expect(retryQueueCount).toBe(0);
        expect(dlqCount).toBe(0);
    }, 30000);
});
