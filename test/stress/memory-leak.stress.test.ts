import { TestContainersManager } from '../utils/test-containers';
import { ResilientConsumer } from '../../src/resilience/resilient-consumer';
import { ResilientEventPublisher } from '../../src/resilience/resilient-event-publisher';
import { EventStoreMock } from '../utils/event-store-mock';
import { createTestEvent } from '../fixtures/events';
import { EventMessage } from '../../src/types';

/**
 * Helper function to get current memory usage in MB.
 */
function getMemoryUsageMB(): number {
    const usage = process.memoryUsage();
    return usage.heapUsed / 1024 / 1024;
}

/**
 * Helper function to force garbage collection if available.
 */
function forceGC(): void {
    if (global.gc) {
        global.gc();
    }
}

describe('Stress Test: Memory Leak Detection', () => {
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

    it('should not leak memory when processing 1000+ messages', async () => {
        const testQueue = `stress-test-memory-${Date.now()}`;
        const totalMessages = 1000;
        const checkInterval = 100; // Check memory every 100 messages
        const memorySnapshots: Array<{ messageCount: number; memoryMB: number }> = [];
        let processedCount = 0;

        // Setup publisher
        publisher = new ResilientEventPublisher({
            connection: connectionUrl,
            queue: testQueue,
            instantPublish: true
        });

        // Setup consumer
        consumer = new ResilientConsumer({
            connection: connectionUrl,
            consumeQueue: {
                queue: testQueue,
                options: { durable: false }
            },
            eventsToProcess: [
                {
                    type: 'stress.test',
                    handler: async (event: EventMessage) => {
                        // Simulate some processing
                        const data = JSON.stringify(event);
                        JSON.parse(data);
                        
                        processedCount++;

                        // Take memory snapshot every checkInterval messages
                        if (processedCount % checkInterval === 0) {
                            forceGC();
                            await new Promise(resolve => setTimeout(resolve, 100));
                            
                            const memoryMB = getMemoryUsageMB();
                            memorySnapshots.push({
                                messageCount: processedCount,
                                memoryMB
                            });
                            
                            console.log(`Processed ${processedCount} messages, Memory: ${memoryMB.toFixed(2)} MB`);
                        }
                    }
                }
            ],
            prefetch: 50
        });

        // Record initial memory
        forceGC();
        await new Promise(resolve => setTimeout(resolve, 100));
        const initialMemory = getMemoryUsageMB();
        console.log(`\nInitial Memory: ${initialMemory.toFixed(2)} MB`);

        // Start consumer
        await consumer.start();

        // Publish all messages
        console.log(`Publishing ${totalMessages} messages...`);
        for (let i = 0; i < totalMessages; i++) {
            const event = createTestEvent(
                { index: i, data: 'x'.repeat(1000) }, // 1KB payload
                'stress.test'
            );
            await publisher.publish(event);
        }

        // Wait for all messages to be processed
        const maxWaitTime = 60000; // 60 seconds
        const waitStart = Date.now();
        while (processedCount < totalMessages && Date.now() - waitStart < maxWaitTime) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }

        // Final memory check
        forceGC();
        await new Promise(resolve => setTimeout(resolve, 100));
        const finalMemory = getMemoryUsageMB();
        const memoryIncrease = finalMemory - initialMemory;

        console.log(`\nFinal Memory: ${finalMemory.toFixed(2)} MB`);
        console.log(`Memory Increase: ${memoryIncrease.toFixed(2)} MB`);
        console.log(`\nMemory Snapshots:`);
        memorySnapshots.forEach(snapshot => {
            console.log(`  ${snapshot.messageCount} messages: ${snapshot.memoryMB.toFixed(2)} MB`);
        });

        // Analyze memory trend
        if (memorySnapshots.length >= 2) {
            const firstSnapshot = memorySnapshots[0];
            const lastSnapshot = memorySnapshots[memorySnapshots.length - 1];
            const trend = lastSnapshot.memoryMB - firstSnapshot.memoryMB;
            console.log(`\nMemory Trend: ${trend > 0 ? '+' : ''}${trend.toFixed(2)} MB`);
        }

        // Validations
        expect(processedCount).toBe(totalMessages);
        expect(memoryIncrease).toBeLessThan(50); // Memory increase should be less than 50MB
        
        // Additional check: memory should stabilize (last snapshot shouldn't be significantly higher than first)
        if (memorySnapshots.length >= 2) {
            const firstSnapshot = memorySnapshots[0];
            const lastSnapshot = memorySnapshots[memorySnapshots.length - 1];
            const memoryGrowth = lastSnapshot.memoryMB - firstSnapshot.memoryMB;
            
            // Memory growth during processing should be reasonable
            expect(memoryGrowth).toBeLessThan(30);
        }
    }, 300000);
});
