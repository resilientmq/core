import {ResilientEventPublisher} from '../../../src/resilience/resilient-event-publisher';
import {EventPublishStatus, ResilientPublisherConfig} from '../../../src/types';
import {AMQPLibMock} from '../../utils/amqplib-mock';
import {EventStoreMock} from '../../utils/event-store-mock';

jest.mock('amqplib', () => ({connect: jest.fn()}));

describe('ResilientEventPublisher distributed outbox', () => {
    let library: AMQPLibMock;
    let store: EventStoreMock;
    const publishers: ResilientEventPublisher[] = [];

    beforeEach(() => {
        library = new AMQPLibMock();
        store = new EventStoreMock();
        require('amqplib').connect.mockImplementation((config: unknown) => library.connect(config as string));
    });

    afterEach(async () => {
        await Promise.all(publishers.splice(0).map(publisher => publisher.disconnect()));
        jest.clearAllMocks();
    });

    it('allows two replicas to publish each pending row exactly once under valid leases', async () => {
        await seedPending(40);
        const first = createPublisher();
        const second = createPublisher();
        await Promise.all([
            first.processPendingEvents({batchSize: 5, maxPublishesPerSecond: 10000, maxConcurrentPublishes: 5}),
            second.processPendingEvents({batchSize: 5, maxPublishesPerSecond: 10000, maxConcurrentPublishes: 5})
        ]);
        const messages = library.getPublishedMessages('orders');
        expect(messages).toHaveLength(40);
        expect(new Set(messages.map(message => message.properties.messageId)).size).toBe(40);
        expect(store.getAllEvents().every(event => event.status === EventPublishStatus.PUBLISHED)).toBe(true);
    });

    it('uses one rate schedule across batch boundaries', async () => {
        await seedPending(3);
        const publisher = createPublisher();
        const startedAt = Date.now();
        await publisher.processPendingEvents({batchSize: 1, maxPublishesPerSecond: 5, maxConcurrentPublishes: 3});
        expect(Date.now() - startedAt).toBeGreaterThanOrEqual(350);
        expect(library.getPublishedMessages('orders')).toHaveLength(3);
    });

    it('does not apply an implicit publication rate when none is configured', async () => {
        await seedPending(5);
        const publisher = createPublisher();
        const startedAt = Date.now();
        await publisher.processPendingEvents({batchSize: 5});
        expect(Date.now() - startedAt).toBeLessThan(300);
        expect(library.getPublishedMessages('orders')).toHaveLength(5);
    });

    it('never exceeds configured unconfirmed concurrency', async () => {
        await seedPending(12);
        const publisher = createPublisher();
        let active = 0;
        let maximum = 0;
        jest.spyOn(publisher as any, 'publishConfirmed').mockImplementation(async () => {
            active++;
            maximum = Math.max(maximum, active);
            await new Promise(resolve => setTimeout(resolve, 5));
            active--;
        });
        await publisher.processPendingEvents({
            batchSize: 12,
            maxPublishesPerSecond: 10000,
            maxConcurrentPublishes: 3
        });
        expect(maximum).toBe(3);
    });

    it('releases a failed row for a later pass without selecting it forever', async () => {
        await seedPending(1);
        const publisher = createPublisher({outboxRetryDelayMs: 60000});
        jest.spyOn(publisher as any, 'publishConfirmed').mockRejectedValue(new Error('broker down'));
        await expect(publisher.processPendingEvents({batchSize: 1, maxPublishesPerSecond: 100, maxConcurrentPublishes: 1}))
            .resolves.toBeUndefined();
        expect((await store.getEvent({messageId: 'event-0', payload: null}))?.status).toBe(EventPublishStatus.PENDING);
        expect(store.getCallCount('releasePublishEvent')).toBe(1);
        expect(store.getCallCount('claimPendingEvents')).toBeLessThanOrEqual(2);
    });

    it('recovers an expired claim left by a stopped process', async () => {
        await seedPending(1);
        await store.claimPendingEvents({
            serviceId: 'same-service',
            instanceId: 'dead-process',
            limit: 1,
            leaseDurationMs: 1,
            now: 0
        });
        const publisher = createPublisher();
        await publisher.processPendingEvents({batchSize: 1, maxPublishesPerSecond: 100, maxConcurrentPublishes: 1});
        expect(library.getPublishedMessages('orders')).toHaveLength(1);
    });

    it('shares one in-process pending pass instead of racing itself', async () => {
        await seedPending(5);
        const publisher = createPublisher();
        await Promise.all([
            publisher.processPendingEvents({batchSize: 5, maxPublishesPerSecond: 1000}),
            publisher.processPendingEvents({batchSize: 5, maxPublishesPerSecond: 1000})
        ]);
        expect(library.getPublishedMessages('orders')).toHaveLength(5);
    });

    async function seedPending(count: number): Promise<void> {
        for (let index = 0; index < count; index++) {
            await store.saveEvent({
                messageId: `event-${index}`,
                type: 'order.created',
                payload: {index},
                status: EventPublishStatus.PENDING
            });
        }
    }

    function createPublisher(overrides: Partial<ResilientPublisherConfig> = {}): ResilientEventPublisher {
        const publisher = new ResilientEventPublisher({
            connection: 'amqp://localhost',
            queue: 'orders',
            serviceId: 'outbox-service',
            store,
            instantPublish: false,
            ...overrides
        });
        publishers.push(publisher);
        return publisher;
    }
});
