import { TestContainersManager } from '../utils/test-containers';
import { ResilientConsumer } from '../../src/resilience/resilient-consumer';
import { ResilientEventPublisher } from '../../src/resilience/resilient-event-publisher';
import { EventStoreMock } from '../utils/event-store-mock';
import { EventMessage } from '../../src/types';
import { createTestEvent } from '../fixtures/events';

describe('Stress Test: Concurrent Consumers', () => {
    let containerManager: TestContainersManager;
    let connectionUrl: string;
    let consumers: ResilientConsumer[] = [];
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
        consumers = [];
    });

    afterEach(async () => {
        // Stop all consumers
        for (const consumer of consumers) {
            await consumer.stop();
        }
        consumers = [];
        
        if (publisher) {
            publisher.stopPendingEventsCheck();
            await publisher.disconnect();
        }
        store.clear();
    });

    it('should distribute 1000 messages across 5 concurrent consumers with no duplicates', async () => {
        const testQueue = `stress-test-concurrent-${Date.now()}`;
        const totalMessages = 1000;
        const consumerCount = 5;
        const processedMessages = new Map<number, string[]>(); // consumer index -> message IDs
        const allProcessedMessagesArray: string[] = []; // Use array instead of Set for thread-safety
        let totalProcessed = 0;

        // Initialize tracking for each consumer
        for (let i = 0; i < consumerCount; i++) {
            processedMessages.set(i, []);
        }

        // Setup publisher
        publisher = new ResilientEventPublisher({
            connection: connectionUrl,
            queue: testQueue,
            instantPublish: true
        });

        // Setup multiple consumers
        console.log(`\nStarting ${consumerCount} concurrent consumers...`);
        for (let i = 0; i < consumerCount; i++) {
            const consumerIndex = i;
            
            const consumer = new ResilientConsumer({
                connection: connectionUrl,
                consumeQueue: {
                    queue: testQueue,
                    options: { durable: true }
                },
                eventsToProcess: [
                    {
                        type: 'stress.test',
                        handler: async (event: EventMessage) => {
                            // Track which consumer processed this message
                            processedMessages.get(consumerIndex)!.push(event.messageId);
                            allProcessedMessagesArray.push(event.messageId);
                            totalProcessed++;

                            // Simulate some processing time
                            await new Promise(resolve => setTimeout(resolve, 5));
                        }
                    }
                ],
                prefetch: 10
            });

            await consumer.start();
            consumers.push(consumer);
            console.log(`Consumer ${i + 1} started`);
        }

        // Wait a bit for all consumers to be ready
        await new Promise(resolve => setTimeout(resolve, 2000));

        // Publish all messages
        console.log(`\nPublishing ${totalMessages} messages...`);
        const publishPromises = [];
        
        for (let i = 0; i < totalMessages; i++) {
            const event = createTestEvent({ index: i, timestamp: Date.now() }, 'stress.test');
            publishPromises.push(publisher.publish(event));
        }
        await Promise.all(publishPromises);
        console.log('All messages published');

        // Wait for all messages to be processed
        const maxWaitTime = 60000; // 60 seconds
        const waitStart = Date.now();
        while (totalProcessed < totalMessages && Date.now() - waitStart < maxWaitTime) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }

        // Calculate unique messages from array
        const allProcessedMessages = new Set(allProcessedMessagesArray);
        
        console.log(`\n=== Concurrent Consumers Stress Test Results ===`);
        console.log(`Total Messages Published: ${totalMessages}`);
        console.log(`Total Messages Processed: ${totalProcessed}`);
        console.log(`Unique Messages Processed: ${allProcessedMessages.size}`);
        console.log(`\nLoad Distribution:`);
        
        let minLoad = Infinity;
        let maxLoad = 0;
        
        for (let i = 0; i < consumerCount; i++) {
            const count = processedMessages.get(i)!.length;
            const percentage = ((count / totalMessages) * 100).toFixed(2);
            console.log(`  Consumer ${i + 1}: ${count} messages (${percentage}%)`);
            
            minLoad = Math.min(minLoad, count);
            maxLoad = Math.max(maxLoad, count);
        }

        const loadImbalance = maxLoad - minLoad;
        const avgLoad = totalMessages / consumerCount;
        const loadImbalancePercent = ((loadImbalance / avgLoad) * 100).toFixed(2);
        
        console.log(`\nLoad Balance Analysis:`);
        console.log(`  Min Load: ${minLoad} messages`);
        console.log(`  Max Load: ${maxLoad} messages`);
        console.log(`  Avg Load: ${avgLoad.toFixed(2)} messages`);
        console.log(`  Load Imbalance: ${loadImbalance} messages (${loadImbalancePercent}%)`);
        console.log('===============================================\n');

        // Validations
        expect(totalProcessed).toBe(totalMessages);
        expect(allProcessedMessages.size).toBe(totalMessages); // No duplicates
        
        // Each consumer should have processed at least some messages
        for (let i = 0; i < consumerCount; i++) {
            const count = processedMessages.get(i)!.length;
            expect(count).toBeGreaterThan(0);
        }

        // Load should be reasonably distributed (no consumer should have more than 40% of messages)
        for (let i = 0; i < consumerCount; i++) {
            const count = processedMessages.get(i)!.length;
            const percentage = (count / totalMessages) * 100;
            expect(percentage).toBeLessThan(40);
        }
    }, 300000);
});
