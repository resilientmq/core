import {writeFileSync} from 'fs';
import {join} from 'path';
import {ResilientConsumer, ResilientEventPublisher} from '../../src';
import {RabbitMQHelpers} from '../utils/rabbitmq-helpers';
import {TestContainersManager} from '../utils/test-containers';

type ConsumeResult = {
    prefetch: number;
    messages: number;
    handlerDelayMs: number;
    durationMs: number;
    throughput: number;
};

/** Measures asynchronous handler throughput with an already-populated real RabbitMQ queue. */
describe('Benchmark: prefetch scaling', () => {
    const messageCount = 400;
    const handlerDelayMs = 10;
    const results: ConsumeResult[] = [];
    let containers: TestContainersManager;
    let connection: string;
    let rabbit: RabbitMQHelpers;

    beforeAll(async () => {
        containers = new TestContainersManager();
        await containers.startRabbitMQ();
        connection = containers.getConnectionUrl();
        rabbit = new RabbitMQHelpers(connection);
    }, 120000);

    afterAll(async () => {
        writeFileSync(
            join(__dirname, '../../test-results/benchmark-consume-throughput.json'),
            JSON.stringify({benchmark: 'prefetch-scaling', timestamp: new Date().toISOString(), results}, null, 2),
            'utf8'
        );
        await rabbit.disconnect();
        await containers.stopAll();
    });

    for (const prefetch of [1, 10, 100, 1000]) {
        it(`measures prefetch ${prefetch}`, async () => {
            const queue = `benchmark.consume.prefetch-${prefetch}`;
            await rabbit.assertQueue(queue);
            const publisher = new ResilientEventPublisher({
                connection,
                queue,
                maxConcurrentPublishes: 200
            });
            await Promise.all(Array.from({length: messageCount}, (_, index) => publisher.publish({
                messageId: `${prefetch}-${index}`,
                type: 'benchmark.consume',
                payload: {index}
            })));
            await publisher.disconnect();

            let releaseHandlers!: () => void;
            const ready = new Promise<void>(resolve => { releaseHandlers = resolve; });
            let consumed = 0;
            let complete!: () => void;
            const completed = new Promise<void>(resolve => { complete = resolve; });
            const consumer = new ResilientConsumer({
                connection,
                serviceId: `benchmark-consumer-${prefetch}`,
                consumeQueue: {queue, options: {durable: true}},
                prefetch,
                processingTimeoutMs: 30000,
                processingLeaseMs: 35000,
                eventsToProcess: [{
                    type: 'benchmark.consume',
                    handler: async () => {
                        await ready;
                        await new Promise(resolve => setTimeout(resolve, handlerDelayMs));
                        consumed++;
                        if (consumed === messageCount) complete();
                    }
                }]
            });

            await consumer.start();
            const startedAt = performance.now();
            releaseHandlers();
            await completed;
            const durationMs = performance.now() - startedAt;
            await consumer.stop();

            const throughput = messageCount / (durationMs / 1000);
            results.push({prefetch, messages: messageCount, handlerDelayMs, durationMs, throughput});
            console.log(`prefetch=${prefetch}: ${throughput.toFixed(0)} msg/s (${durationMs.toFixed(1)}ms)`);
            expect(consumed).toBe(messageCount);
        }, 60000);
    }

    it('demonstrates that prefetch changes throughput for overlapping handlers', () => {
        const byPrefetch = new Map(results.map(result => [result.prefetch, result.throughput]));
        expect(byPrefetch.get(10)!).toBeGreaterThan(byPrefetch.get(1)! * 2);
        expect(byPrefetch.get(100)!).toBeGreaterThan(byPrefetch.get(10)! * 1.2);
    });
});
