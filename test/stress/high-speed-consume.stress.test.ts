import { TestContainersManager } from '../utils/test-containers';
import { MetricsCollector } from '../utils/metrics-collector';
import { ResilientConsumer } from '../../src/resilience/resilient-consumer';
import { ResilientEventPublisher } from '../../src/resilience/resilient-event-publisher';
import { EventStoreMock } from '../utils/event-store-mock';
import { createTestEvent } from '../fixtures/events';
import { EventMessage } from '../../src/types';

describe('Stress Test: High Speed Consumption', () => {
    let containerManager: TestContainersManager;
    let connectionUrl: string;
    let consumer: ResilientConsumer;
    let publisher: ResilientEventPublisher;
    let store: EventStoreMock;
    let metricsCollector: MetricsCollector;

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
        metricsCollector = new MetricsCollector();
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

    it('should consume messages at high speed for 60 seconds without errors', async () => {
        const testQueue = `stress-test-high-speed-${Date.now()}`;
        const testDurationMs = 60000; // 60 seconds
        const publishIntervalMs = 10; // Publish every 10ms
        let processedCount = 0;
        let errorCount = 0;

        // Setup publisher
        publisher = new ResilientEventPublisher({
            connection: connectionUrl,
            queue: testQueue,
            instantPublish: true
        });

        // Setup consumer
        const processedMessages: string[] = [];
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
                        const startTime = Date.now();
                        processedMessages.push(event.messageId);
                        processedCount++;
                        
                        // Simulate minimal processing
                        await new Promise(resolve => setTimeout(resolve, 1));
                        
                        const latency = Date.now() - startTime;
                        metricsCollector.recordMessage(latency);
                    }
                }
            ],
            prefetch: 100
        });

        metricsCollector.start();

        // Start consumer
        await consumer.start();

        // Publish messages continuously for test duration
        const startTime = Date.now();
        let publishedCount = 0;

        const publishLoop = async () => {
            while (Date.now() - startTime < testDurationMs) {
                try {
                    const event = createTestEvent(
                        { index: publishedCount, timestamp: Date.now() },
                        'stress.test'
                    );
                    await publisher.publish(event);
                    publishedCount++;
                } catch (error) {
                    errorCount++;
                    console.error('Publish error:', error);
                }
                
                await new Promise(resolve => setTimeout(resolve, publishIntervalMs));
            }
        };

        await publishLoop();

        // Wait for all messages to be processed
        const maxWaitTime = 30000; // 30 seconds
        const waitStart = Date.now();
        while (processedCount < publishedCount && Date.now() - waitStart < maxWaitTime) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }

        const metrics = metricsCollector.stop();

        console.log('\n=== High Speed Consumption Stress Test Results ===');
        console.log(`Test Duration: ${testDurationMs / 1000} seconds`);
        console.log(`Messages Published: ${publishedCount}`);
        console.log(`Messages Processed: ${processedCount}`);
        console.log(`Processing Errors: ${errorCount}`);
        console.log(`Throughput: ${metrics.throughput.toFixed(2)} msg/s`);
        console.log(`Latency Avg: ${metrics.latencyAvg.toFixed(2)} ms`);
        console.log(`Latency P95: ${metrics.latencyP95.toFixed(2)} ms`);
        console.log(`Latency P99: ${metrics.latencyP99.toFixed(2)} ms`);
        console.log('==================================================\n');

        // Export metrics to JSON
        const metricsPath = './test-results/stress-high-speed-consume.json';
        metricsCollector.exportToJSON(metricsPath);
        console.log(`Metrics exported to ${metricsPath}\n`);

        // Validations
        expect(errorCount).toBe(0);
        expect(processedCount).toBe(publishedCount);
        expect(metrics.throughput).toBeGreaterThan(0);
    }, 300000);
});
