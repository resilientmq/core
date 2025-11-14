import { TestContainersManager } from '../utils/test-containers';
import { ResilientConsumer } from '../../src/resilience/resilient-consumer';
import { ResilientEventPublisher } from '../../src/resilience/resilient-event-publisher';
import { EventStoreMock } from '../utils/event-store-mock';
import { createTestEvent } from '../fixtures/events';
import { EventMessage } from '../../src/types';

describe('Stress Test: Recovery Under Load', () => {
    let containerManager: TestContainersManager;
    let connectionUrl: string;
    let consumer: ResilientConsumer;
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
        if (consumer) {
            await consumer.stop();
        }
        if (publisher) {
            publisher.stopPendingEventsCheck();
            await publisher.disconnect();
        }
        store.clear();
    });

    it('should recover from random failures and eventually process all messages', async () => {
        const testQueue = `stress-test-recovery-${Date.now()}`;
        const retryQueue = `${testQueue}-retry`;
        const totalMessages = 500;
        const failureRate = 0.2; // 20% of messages will fail initially
        const retryTTL = 1000; // 1 second retry delay
        const maxAttempts = 3;

        const processedMessages = new Set<string>();
        const failedAttempts = new Map<string, number>();
        let totalAttempts = 0;
        let successfulProcessing = 0;
        let permanentFailures = 0;

        // Setup publisher
        publisher = new ResilientEventPublisher({
            connection: connectionUrl,
            queue: testQueue,
            instantPublish: true
        });

        // Setup consumer with retry logic
        consumer = new ResilientConsumer({
            connection: connectionUrl,
            consumeQueue: {
                queue: testQueue,
                options: { durable: true }
            },
            retryQueue: {
                queue: retryQueue,
                ttlMs: retryTTL,
                maxAttempts
            },
            eventsToProcess: [
                {
                    type: 'stress.test',
                    handler: async (event: EventMessage) => {
                        totalAttempts++;
                        
                        const attemptCount = (event.properties?.headers?.['x-retry-count'] as number) || 0;
                        const currentAttempts = failedAttempts.get(event.messageId) || 0;
                        failedAttempts.set(event.messageId, currentAttempts + 1);

                        // Simulate random failures (20% chance) but only on first attempt
                        if (attemptCount === 0 && Math.random() < failureRate) {
                            throw new Error(`Simulated failure for message ${event.messageId}`);
                        }

                        // If we get here, processing succeeded
                        processedMessages.add(event.messageId);
                        successfulProcessing++;

                        // Simulate some processing time
                        await new Promise(resolve => setTimeout(resolve, 5));
                    }
                }
            ],
            store,
            prefetch: 20
        });

        console.log(`\nStarting recovery under load test...`);
        console.log(`Total Messages: ${totalMessages}`);
        console.log(`Expected Failure Rate: ${(failureRate * 100).toFixed(0)}%`);
        console.log(`Retry TTL: ${retryTTL}ms`);
        console.log(`Max Attempts: ${maxAttempts}\n`);

        // Start consumer
        await consumer.start();

        // Publish all messages
        console.log('Publishing messages...');
        const publishPromises = [];
        for (let i = 0; i < totalMessages; i++) {
            const event = createTestEvent(
                { index: i, timestamp: Date.now() },
                'stress.test'
            );
            publishPromises.push(publisher.publish(event));
        }
        await Promise.all(publishPromises);
        console.log('All messages published');

        // Wait for all messages to be processed (including retries)
        // This should take at least retryTTL * (maxAttempts - 1) for failed messages
        const maxWaitTime = 120000; // 2 minutes
        const waitStart = Date.now();
        
        let lastProcessedCount = 0;
        let stableCount = 0;
        const stableThreshold = 5; // Consider stable if no change for 5 checks
        
        while (Date.now() - waitStart < maxWaitTime) {
            await new Promise(resolve => setTimeout(resolve, 1000));
            
            const currentProcessed = processedMessages.size;
            
            if (currentProcessed === lastProcessedCount) {
                stableCount++;
                if (stableCount >= stableThreshold) {
                    console.log('Processing appears stable, finishing...');
                    break;
                }
            } else {
                stableCount = 0;
                lastProcessedCount = currentProcessed;
            }
            
            if (currentProcessed >= totalMessages) {
                console.log('All messages processed successfully!');
                break;
            }
        }

        // Calculate statistics
        permanentFailures = totalMessages - processedMessages.size;
        const retryCount = totalAttempts - totalMessages;
        const actualFailureRate = (permanentFailures / totalMessages) * 100;
        const recoveryRate = ((totalMessages - permanentFailures) / totalMessages) * 100;

        console.log(`\n=== Recovery Under Load Stress Test Results ===`);
        console.log(`Total Messages: ${totalMessages}`);
        console.log(`Successfully Processed: ${processedMessages.size}`);
        console.log(`Permanent Failures: ${permanentFailures}`);
        console.log(`Total Processing Attempts: ${totalAttempts}`);
        console.log(`Retry Attempts: ${retryCount}`);
        console.log(`Recovery Rate: ${recoveryRate.toFixed(2)}%`);
        console.log(`Actual Failure Rate: ${actualFailureRate.toFixed(2)}%`);
        
        console.log(`\nRetry Statistics:`);
        let messagesWithRetries = 0;
        let totalRetries = 0;
        failedAttempts.forEach((attempts, messageId) => {
            if (attempts > 1) {
                messagesWithRetries++;
                totalRetries += (attempts - 1);
            }
        });
        console.log(`  Messages that needed retries: ${messagesWithRetries}`);
        console.log(`  Average retries per failed message: ${messagesWithRetries > 0 ? (totalRetries / messagesWithRetries).toFixed(2) : 0}`);
        console.log('===============================================\n');

        // Validations
        // Most messages should eventually be processed (allowing for some that hit max retries)
        expect(processedMessages.size).toBeGreaterThanOrEqual(totalMessages * 0.95); // At least 95% success
        
        // System should have attempted retries
        expect(totalAttempts).toBeGreaterThan(totalMessages);
        
        // Recovery rate should be high
        expect(recoveryRate).toBeGreaterThanOrEqual(95);
    }, 300000);
});
