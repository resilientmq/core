import {writeFileSync} from 'fs';
import {join} from 'path';
import {EventMessage, EventPublishStatus, ResilientEventPublisher} from '../../src';
import {EventStoreMock} from '../utils/event-store-mock';
import {RabbitMQHelpers} from '../utils/rabbitmq-helpers';
import {TestContainersManager} from '../utils/test-containers';

/** Measures two real publisher replicas claiming one shared outbox without duplicates. */
describe('Benchmark: distributed outbox throughput', () => {
    const eventCount = 2000;
    const queue = 'benchmark.outbox.distributed';
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
        await rabbit.disconnect();
        await containers.stopAll();
    });

    it('publishes every claimed row once across both replicas', async () => {
        const store = new EventStoreMock();
        const events: EventMessage[] = Array.from({length: eventCount}, (_, index) => ({
            messageId: `outbox-${index}`,
            type: 'benchmark.outbox',
            payload: {index},
            status: EventPublishStatus.PENDING
        }));
        for (const event of events) await store.saveEvent(event);

        const config = {
            connection,
            serviceId: 'benchmark-outbox',
            queue,
            store,
            instantPublish: false,
            maxConcurrentPublishes: 200,
            outboxLeaseMs: 30000
        };
        const first = new ResilientEventPublisher(config);
        const second = new ResilientEventPublisher(config);
        const startedAt = performance.now();
        await Promise.all([
            first.processPendingEvents({
                batchSize: 250,
                maxPublishesPerSecond: 100000,
                maxConcurrentPublishes: 100
            }),
            second.processPendingEvents({
                batchSize: 250,
                maxPublishesPerSecond: 100000,
                maxConcurrentPublishes: 100
            })
        ]);
        const durationMs = performance.now() - startedAt;
        await Promise.all([first.disconnect(), second.disconnect()]);

        const publishedRows = (await Promise.all(events.map(event => store.getEvent(event))))
            .filter(event => event?.status === EventPublishStatus.PUBLISHED).length;
        const queuedMessages = await rabbit.getMessageCount(queue);
        const throughput = eventCount / (durationMs / 1000);
        writeFileSync(
            join(__dirname, '../../test-results/benchmark-pending-events-throughput.json'),
            JSON.stringify({
                benchmark: 'distributed-outbox-throughput',
                timestamp: new Date().toISOString(),
                replicas: 2,
                eventCount,
                publishedRows,
                queuedMessages,
                durationMs,
                throughput
            }, null, 2),
            'utf8'
        );

        console.log(`outbox replicas=2: ${throughput.toFixed(0)} msg/s, rows=${publishedRows}, queued=${queuedMessages}`);
        expect(publishedRows).toBe(eventCount);
        expect(queuedMessages).toBe(eventCount);
    }, 120000);
});
