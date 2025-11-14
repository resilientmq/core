import { TestContainersManager } from '../utils/test-containers';
import { MetricsCollector } from '../utils/metrics-collector';
import { ResilientEventPublisher } from '../../src/resilience/resilient-event-publisher';
import { EventStoreMock } from '../utils/event-store-mock';
import { createTestEvent } from '../fixtures/events';

describe('Stress Test: High Volume Publishing', () => {
    let containerManager: TestContainersManager;
    let connectionUrl: string;
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
        if (publisher) {
            publisher.stopPendingEventsCheck();
            await publisher.disconnect();
        }
        store.clear();
    });

    it('should handle 10000 concurrent messages with error rate < 1%', async () => {
        const messageCount = 10000;
        const testQueue = `stress-test-high-volume-${Date.now()}`;

        publisher = new ResilientEventPublisher({
            connection: connectionUrl,
            queue: testQueue,
            store,
            instantPublish: true,
            idleTimeoutMs: 0 // Disable idle timeout for stress test
        });

        metricsCollector.start();

        // Publish all messages - publisher handles concurrency internally
        const promises = Array.from({ length: messageCount }, (_, i) => {
            const startTime = Date.now();
            const event = createTestEvent({ index: i, timestamp: Date.now() }, 'stress.test');
            
            return publisher.publish(event)
                .then(() => {
                    const latency = Date.now() - startTime;
                    metricsCollector.recordMessage(latency);
                })
                .catch((error) => {
                    metricsCollector.recordError();
                    console.error(`Failed to publish message ${i}:`, error.message);
                });
        });

        await Promise.all(promises);

        const metrics = metricsCollector.stop();

        console.log('\n=== High Volume Publishing Stress Test Results ===');
        console.log(`Total Messages: ${metrics.totalMessages}`);
        console.log(`Total Errors: ${metrics.totalErrors}`);
        console.log(`Error Rate: ${metrics.errorRate.toFixed(2)}%`);
        console.log(`Throughput: ${metrics.throughput.toFixed(2)} msg/s`);
        console.log(`Latency Avg: ${metrics.latencyAvg.toFixed(2)} ms`);
        console.log(`Latency P50: ${metrics.latencyP50.toFixed(2)} ms`);
        console.log(`Latency P95: ${metrics.latencyP95.toFixed(2)} ms`);
        console.log(`Latency P99: ${metrics.latencyP99.toFixed(2)} ms`);
        console.log(`Duration: ${metrics.duration} ms`);
        console.log('================================================\n');

        // Export metrics to JSON
        const metricsPath = './test-results/stress-high-volume-publish.json';
        metricsCollector.exportToJSON(metricsPath);
        console.log(`Metrics exported to ${metricsPath}\n`);

        // Validations
        expect(metrics.errorRate).toBeLessThan(1);
        // Allow for some connection errors under extreme load
        expect(metrics.totalMessages + metrics.totalErrors).toBe(messageCount);
        expect(metrics.totalMessages).toBeGreaterThanOrEqual(messageCount * 0.99); // At least 99% success
    }, 300000);
});
