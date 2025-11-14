import { ResilientConsumer } from '../../src/resilience/resilient-consumer';
import { ResilientEventPublisher } from '../../src/resilience/resilient-event-publisher';
import { TestContainersManager } from '../utils/test-containers';
import { EventStoreMock } from '../utils/event-store-mock';
import { EventBuilder, ConsumerConfigBuilder, PublisherConfigBuilder } from '../utils/test-data-builders';
import { EventConsumeStatus } from '../../src/types/enum/event-consume-status';
import { RabbitMQHelpers } from '../utils/rabbitmq-helpers';
import { TEST_CONFIG, uniqueQueueName } from './test-config';

describe('Integration: Retry and DLQ Comprehensive Tests', () => {
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
        store.clear();
        publisherStore.clear();
    });

    describe('Without Retry or DLQ', () => {
        it('should process successful message without retry config', async () => {
            const queueName = uniqueQueueName('test.no.retry.success');
            const event = new EventBuilder()
                .withType('test.success')
                .withPayload({ data: 'test' })
                .build();

            let handlerCalled = false;

            const consumerConfig = new ConsumerConfigBuilder()
                .withConnection(connectionUrl)
                .withQueue(queueName)
                .withStore(store)
                .withEventHandler('test.success', async () => {
                    handlerCalled = true;
                })
                .build();

            consumer = new ResilientConsumer(consumerConfig);

            const publisherConfig = new PublisherConfigBuilder()
                .withConnection(connectionUrl)
                .withQueue(queueName)
                .withStore(publisherStore)
                .withInstantPublish(true)
                .build();

            publisher = new ResilientEventPublisher(publisherConfig);

            await consumer.start();
            await new Promise(resolve => setTimeout(resolve, TEST_CONFIG.CONSUMER_READY_DELAY));
            
            await publisher.publish(event);
            await new Promise(resolve => setTimeout(resolve, TEST_CONFIG.MESSAGE_PROCESSING_DELAY));

            expect(handlerCalled).toBe(true);
            const storedEvent = await store.getEvent(event);
            expect(storedEvent?.status).toBe(EventConsumeStatus.DONE);
        }, 10000);

        it('should handle failed message without retry config', async () => {
            const queueName = uniqueQueueName('test.no.retry.fail');
            const event = new EventBuilder()
                .withType('test.fail')
                .withPayload({ data: 'test' })
                .build();

            let attemptCount = 0;

            const consumerConfig = new ConsumerConfigBuilder()
                .withConnection(connectionUrl)
                .withQueue(queueName)
                .withStore(store)
                .withEventHandler('test.fail', async () => {
                    attemptCount++;
                    throw new Error('Simulated failure');
                })
                .build();

            consumer = new ResilientConsumer(consumerConfig);

            const publisherConfig = new PublisherConfigBuilder()
                .withConnection(connectionUrl)
                .withQueue(queueName)
                .withStore(publisherStore)
                .withInstantPublish(true)
                .build();

            publisher = new ResilientEventPublisher(publisherConfig);

            await consumer.start();
            await new Promise(resolve => setTimeout(resolve, TEST_CONFIG.CONSUMER_READY_DELAY));
            
            await publisher.publish(event);
            await new Promise(resolve => setTimeout(resolve, TEST_CONFIG.MESSAGE_PROCESSING_DELAY));

            // Without retry, should only try once
            expect(attemptCount).toBe(1);
        }, 10000);
    });

    describe('With Retry (No DLQ)', () => {
        it('should retry failed message and eventually succeed', async () => {
            const queueName = uniqueQueueName('test.retry.eventual.success');
            const retryQueueName = `${queueName}.retry`;
            const event = new EventBuilder()
                .withType('test.retry.success')
                .withPayload({ data: 'test' })
                .build();

            let attemptCount = 0;

            const consumerConfig = new ConsumerConfigBuilder()
                .withConnection(connectionUrl)
                .withQueue(queueName)
                .withStore(store)
                .withRetryConfig(retryQueueName, TEST_CONFIG.RETRY_TTL, TEST_CONFIG.MAX_ATTEMPTS)
                .withEventHandler('test.retry.success', async () => {
                    attemptCount++;
                    if (attemptCount < 2) {
                        throw new Error('Fail on first attempt');
                    }
                    // Success on second attempt
                })
                .build();

            consumer = new ResilientConsumer(consumerConfig);

            // Start consumer first to create queues with correct DLX configuration
            await consumer.start();
            await new Promise(resolve => setTimeout(resolve, TEST_CONFIG.CONSUMER_READY_DELAY));

            const publisherConfig = new PublisherConfigBuilder()
                .withConnection(connectionUrl)
                .withQueue(queueName)
                .withStore(publisherStore)
                .withInstantPublish(true)
                .build();

            publisher = new ResilientEventPublisher(publisherConfig);
            
            await publisher.publish(event);
            
            // Wait for initial attempt + TTL + retry
            await new Promise(resolve => setTimeout(resolve, TEST_CONFIG.RETRY_TTL + TEST_CONFIG.MESSAGE_PROCESSING_DELAY + 1000));

            expect(attemptCount).toBeGreaterThanOrEqual(2);
            const storedEvent = await store.getEvent(event);
            expect(storedEvent?.status).toBe(EventConsumeStatus.DONE);
        }, 15000);
    });

    describe('With Retry and DLQ', () => {
        it('should retry and send to DLQ after max attempts', async () => {
            const queueName = uniqueQueueName('test.with.dlq');
            const retryQueueName = `${queueName}.retry`;
            const dlqName = `${queueName}.dlq`;
            const event = new EventBuilder()
                .withType('test.dlq')
                .withPayload({ data: 'test' })
                .build();

            let attemptCount = 0;

            const consumerConfig = new ConsumerConfigBuilder()
                .withConnection(connectionUrl)
                .withQueue(queueName)
                .withStore(store)
                .withRetryConfig(retryQueueName, TEST_CONFIG.RETRY_TTL, TEST_CONFIG.MAX_ATTEMPTS)
                .withDeadLetterQueue(dlqName)
                .withEventHandler('test.dlq', async () => {
                    attemptCount++;
                    throw new Error('Always fails');
                })
                .build();

            consumer = new ResilientConsumer(consumerConfig);

            // Start consumer first to create queues with correct DLX configuration
            await consumer.start();
            await new Promise(resolve => setTimeout(resolve, TEST_CONFIG.CONSUMER_READY_DELAY));

            const publisherConfig = new PublisherConfigBuilder()
                .withConnection(connectionUrl)
                .withQueue(queueName)
                .withStore(publisherStore)
                .withInstantPublish(true)
                .build();

            publisher = new ResilientEventPublisher(publisherConfig);
            
            await publisher.publish(event);
            
            // Wait for all retries: initial + (TTL + retry) * maxAttempts
            const totalWait = TEST_CONFIG.MESSAGE_PROCESSING_DELAY + 
                             (TEST_CONFIG.RETRY_TTL + 500) * TEST_CONFIG.MAX_ATTEMPTS + 
                             1000;
            await new Promise(resolve => setTimeout(resolve, totalWait));

            expect(attemptCount).toBeGreaterThanOrEqual(TEST_CONFIG.MAX_ATTEMPTS);
            
            const storedEvent = await store.getEvent(event);
            expect(storedEvent?.status).toBe(EventConsumeStatus.ERROR);
            
            // Verify message is in DLQ
            const dlqCount = await rabbitMQHelpers.getMessageCount(dlqName);
            expect(dlqCount).toBeGreaterThan(0);
        }, 20000);
    });

    describe('Without Store', () => {
        it('should process message without store', async () => {
            const queueName = uniqueQueueName('test.no.store.queue');
            const event = new EventBuilder()
                .withType('test.no.store')
                .withPayload({ data: 'test' })
                .build();

            let handlerCalled = false;

            const consumerConfig = new ConsumerConfigBuilder()
                .withConnection(connectionUrl)
                .withQueue(queueName)
                .withEventHandler('test.no.store', async () => {
                    handlerCalled = true;
                })
                .build();

            // Remove store from config
            delete (consumerConfig as any).store;

            consumer = new ResilientConsumer(consumerConfig);

            const publisherConfig = new PublisherConfigBuilder()
                .withConnection(connectionUrl)
                .withQueue(queueName)
                .withInstantPublish(true)
                .build();

            // Remove store from publisher config
            delete (publisherConfig as any).store;

            publisher = new ResilientEventPublisher(publisherConfig);

            await consumer.start();
            await new Promise(resolve => setTimeout(resolve, TEST_CONFIG.CONSUMER_READY_DELAY));
            
            await publisher.publish(event);
            await new Promise(resolve => setTimeout(resolve, TEST_CONFIG.MESSAGE_PROCESSING_DELAY));

            expect(handlerCalled).toBe(true);
        }, 10000);
    });
});
