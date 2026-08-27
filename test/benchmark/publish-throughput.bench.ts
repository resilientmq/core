import {writeFileSync} from 'fs';
import {join} from 'path';
import {ResilientEventPublisher} from '../../src';
import {RabbitMQHelpers} from '../utils/rabbitmq-helpers';
import {TestContainersManager} from '../utils/test-containers';

type PublishResult = {
    maxConcurrentPublishes: number;
    messages: number;
    durationMs: number;
    throughput: number;
};

/** Measures the publisher-confirm window on one long-lived real RabbitMQ connection. */
describe('Benchmark: publisher confirm concurrency', () => {
    const messageCount = 2000;
    const queue = 'benchmark.publish.confirm-concurrency';
    const results: PublishResult[] = [];
    let containers: TestContainersManager;
    let connection: string;
    let rabbit: RabbitMQHelpers;

    beforeAll(async () => {
        containers = new TestContainersManager();
        await containers.startRabbitMQ();
        connection = containers.getConnectionUrl();
        rabbit = new RabbitMQHelpers(connection);
        await rabbit.assertQueue(queue);
    }, 120000);

    afterAll(async () => {
        writeFileSync(
            join(__dirname, '../../test-results/benchmark-publish-throughput.json'),
            JSON.stringify({benchmark: 'publisher-confirm-concurrency', timestamp: new Date().toISOString(), results}, null, 2),
            'utf8'
        );
        await rabbit.disconnect();
        await containers.stopAll();
    });

    for (const maxConcurrentPublishes of [1, 10, 100, 1000]) {
        it(`measures ${maxConcurrentPublishes} unconfirmed publications`, async () => {
            await rabbit.purgeQueue(queue);
            const publisher = new ResilientEventPublisher({
                connection,
                queue,
                maxConcurrentPublishes,
                confirmTimeoutMs: 30000
            });
            const startedAt = performance.now();
            await Promise.all(Array.from({length: messageCount}, (_, index) => publisher.publish({
                messageId: `${maxConcurrentPublishes}-${index}`,
                type: 'benchmark.publish',
                payload: {index}
            })));
            const durationMs = performance.now() - startedAt;
            await publisher.disconnect();
            const throughput = messageCount / (durationMs / 1000);
            results.push({maxConcurrentPublishes, messages: messageCount, durationMs, throughput});

            console.log(`confirm concurrency=${maxConcurrentPublishes}: ${throughput.toFixed(0)} msg/s (${durationMs.toFixed(1)}ms)`);
            expect(await rabbit.getMessageCount(queue)).toBe(messageCount);
        }, 120000);
    }

    it('demonstrates that confirm concurrency changes publication throughput', () => {
        const byConcurrency = new Map(results.map(result => [result.maxConcurrentPublishes, result.throughput]));
        expect(byConcurrency.get(10)!).toBeGreaterThan(byConcurrency.get(1)! * 1.5);
    });
});
