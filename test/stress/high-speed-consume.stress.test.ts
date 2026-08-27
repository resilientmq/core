import {ResilientConsumer} from '../../src/resilience/resilient-consumer';
import {ResilientEventPublisher} from '../../src/resilience/resilient-event-publisher';
import {MetricsCollector} from '../utils/metrics-collector';
import {RabbitMQHelpers} from '../utils/rabbitmq-helpers';
import {TestContainersManager} from '../utils/test-containers';

/** Stresses consumer drain throughput without producer pacing in the measurement window. */
describe('Stress Test: High Speed Consumption', () => {
    const messageCount = 10000;
    let containers: TestContainersManager;
    let connection: string;
    let rabbit: RabbitMQHelpers;
    let consumer: ResilientConsumer | undefined;
    let publisher: ResilientEventPublisher | undefined;

    beforeAll(async () => {
        containers = new TestContainersManager();
        await containers.startRabbitMQ();
        connection = containers.getConnectionUrl();
        rabbit = new RabbitMQHelpers(connection);
    }, 120000);

    afterEach(async () => {
        await consumer?.stop();
        await publisher?.disconnect();
        consumer = undefined;
        publisher = undefined;
    });

    afterAll(async () => {
        await rabbit.disconnect();
        await containers.stopAll();
    }, 30000);

    it('drains 10000 preloaded messages without errors or duplicates', async () => {
        const queue = `stress-consume-${Date.now()}`;
        await rabbit.assertQueue(queue);
        publisher = new ResilientEventPublisher({
            connection,
            queue,
            maxConcurrentPublishes: 500
        });
        await Promise.all(Array.from({length: messageCount}, (_, index) => publisher!.publish({
            messageId: `stress-consume-${index}`,
            type: 'stress.consume',
            payload: {index}
        })));
        await publisher.disconnect();
        publisher = undefined;

        const metrics = new MetricsCollector();
        const processed = new Set<string>();
        let duplicateCount = 0;
        let resolveComplete!: () => void;
        const complete = new Promise<void>(resolve => { resolveComplete = resolve; });
        consumer = new ResilientConsumer({
            connection,
            serviceId: 'stress-consumer',
            consumeQueue: {queue, options: {durable: true}},
            prefetch: 500,
            eventsToProcess: [{
                type: 'stress.consume',
                handler: async event => {
                    const startedAt = performance.now();
                    await new Promise(resolve => setTimeout(resolve, 1));
                    if (processed.has(event.messageId)) duplicateCount++;
                    processed.add(event.messageId);
                    metrics.recordMessage(performance.now() - startedAt);
                    if (processed.size === messageCount) resolveComplete();
                }
            }]
        });

        metrics.start();
        const startedAt = performance.now();
        await consumer.start();
        await complete;
        const durationMs = performance.now() - startedAt;
        const result = metrics.stop();
        const throughput = messageCount / (durationMs / 1000);
        metrics.exportToJSON('./test-results/stress-high-speed-consume.json');

        console.log(`consumer drain: ${throughput.toFixed(0)} msg/s, messages=${processed.size}, duplicates=${duplicateCount}`);
        expect(processed.size).toBe(messageCount);
        expect(duplicateCount).toBe(0);
        expect(await rabbit.getMessageCount(queue)).toBe(0);
        expect(result.totalErrors).toBe(0);
    }, 120000);
});
