import {ResilientEventPublisher} from '../../../src/resilience/resilient-event-publisher';
import {EventPublishStatus} from '../../../src/types';
import {AMQPLibMock, MockChannel} from '../../utils/amqplib-mock';
import {EventStoreMock} from '../../utils/event-store-mock';

jest.mock('amqplib', () => ({connect: jest.fn()}));

describe('ResilientEventPublisher confirmed publishing', () => {
    let library: AMQPLibMock;
    const publishers: ResilientEventPublisher[] = [];

    beforeEach(() => {
        library = new AMQPLibMock();
        require('amqplib').connect.mockImplementation((config: unknown) => library.connect(config as string));
    });

    afterEach(async () => {
        await Promise.all(publishers.splice(0).map(publisher => publisher.disconnect()));
        jest.clearAllMocks();
    });

    it('requires a queue or exchange destination', () => {
        expect(() => new ResilientEventPublisher({connection: 'amqp://localhost'})).toThrow('queue');
    });

    it('publishes without a store only after broker confirmation', async () => {
        const publisher = track(new ResilientEventPublisher({connection: 'amqp://localhost', queue: 'orders'}));
        await publisher.publish({messageId: 'one', type: 'order.created', payload: {id: 1}});
        expect(library.getPublishedMessages('orders')).toHaveLength(1);
        expect(publisher.isConnected()).toBe(true);
    });

    it('allows a long confirm timeout when no outbox lease is used', async () => {
        const publisher = track(new ResilientEventPublisher({
            connection: 'amqp://localhost',
            queue: 'orders',
            confirmTimeoutMs: 30000
        }));
        await expect(publisher.publish({messageId: 'long-confirm', payload: {}})).resolves.toBeUndefined();
    });

    it('rejects a non-positive confirm timeout', () => {
        expect(() => new ResilientEventPublisher({
            connection: 'amqp://localhost',
            queue: 'orders',
            confirmTimeoutMs: 0
        })).toThrow('confirmTimeoutMs');
        expect(() => new ResilientEventPublisher({
            connection: 'amqp://localhost',
            queue: 'orders',
            confirmTimeoutMs: Number.POSITIVE_INFINITY
        })).toThrow('confirmTimeoutMs');
    });

    it('requires an outbox lease longer than its confirm deadline', () => {
        expect(() => new ResilientEventPublisher({
            connection: 'amqp://localhost',
            queue: 'orders',
            store: new EventStoreMock(),
            confirmTimeoutMs: 30000,
            outboxLeaseMs: 30000
        })).toThrow('two confirm timeouts');
    });

    it('rejects a non-positive publisher shutdown timeout', () => {
        expect(() => new ResilientEventPublisher({
            connection: 'amqp://localhost',
            queue: 'orders',
            shutdownTimeoutMs: 0
        })).toThrow('shutdownTimeoutMs');
    });

    it('atomically claims and completes an instant outbox event', async () => {
        const store = new EventStoreMock();
        const publisher = track(new ResilientEventPublisher({
            connection: 'amqp://localhost',
            queue: 'orders',
            store
        }));
        await publisher.publish({messageId: 'stored', payload: {}});
        expect((await store.getEvent({messageId: 'stored', payload: null}))?.status).toBe(EventPublishStatus.PUBLISHED);
        expect(store.getCallCount('claimPublishEvent')).toBe(1);
        expect(store.getCallCount('completePublishedEvent')).toBe(1);
    });

    it('does not republish an already completed identity', async () => {
        const store = new EventStoreMock();
        const publisher = track(new ResilientEventPublisher({connection: 'amqp://localhost', queue: 'orders', store}));
        const event = {messageId: 'duplicate', payload: {}};
        await publisher.publish(event);
        await publisher.publish(event);
        expect(library.getPublishedMessages('orders')).toHaveLength(1);
    });

    it('releases a failed atomic claim as PENDING instead of writing a terminal error', async () => {
        const store = new EventStoreMock();
        const publisher = track(new ResilientEventPublisher({connection: 'amqp://localhost', queue: 'orders', store}));
        jest.spyOn(publisher as any, 'publishConfirmed').mockRejectedValue(new Error('confirm unavailable'));
        await expect(publisher.publish({messageId: 'pending', payload: {}})).rejects.toThrow();
        expect((await store.getEvent({messageId: 'pending', payload: null}))?.status).toBe(EventPublishStatus.PENDING);
        expect(store.getCallCount('releasePublishEvent')).toBe(1);
    });

    it('reconnects and retries once after a channel failure', async () => {
        const publisher = track(new ResilientEventPublisher({connection: 'amqp://localhost', queue: 'orders'}));
        await (publisher as any).ensureConnected();
        const channel = (publisher as any).queue.channel as MockChannel;
        channel.failNextConfirm(new Error('channel closed'));
        await expect(publisher.publish({messageId: 'recover', payload: {}})).resolves.toBeUndefined();
        expect(require('amqplib').connect).toHaveBeenCalledTimes(2);
    });

    it('rejects storeOnly when no store can persist the event', async () => {
        const publisher = track(new ResilientEventPublisher({connection: 'amqp://localhost', queue: 'orders'}));
        await expect(publisher.publish({messageId: 'missing-store', payload: {}}, {storeOnly: true}))
            .rejects.toThrow('storeOnly');
    });

    it('requires fenced outbox methods for deferred mode', () => {
        const incompleteStore = new EventStoreMock();
        (incompleteStore as any).claimPendingEvents = undefined;
        expect(() => new ResilientEventPublisher({
            connection: 'amqp://localhost',
            queue: 'orders',
            store: incompleteStore,
            instantPublish: false
        })).toThrow('distributed outbox');
    });

    it('rejects a non-atomic store instead of silently weakening replica safety', () => {
        const legacyStore = {
            saveEvent: jest.fn(),
            updateEventStatus: jest.fn(),
            getEvent: jest.fn(),
            deleteEvent: jest.fn()
        };
        expect(() => new ResilientEventPublisher({
            connection: 'amqp://localhost',
            queue: 'orders',
            store: legacyStore
        })).toThrow('idempotent enqueue and fenced publication');
    });

    it('adds stable service and process identities to each publication', async () => {
        const publisher = track(new ResilientEventPublisher({
            connection: 'amqp://localhost',
            queue: 'orders',
            serviceId: 'orders-api'
        }));
        await publisher.publish({messageId: 'identity', payload: {}});
        const headers = library.getPublishedMessages('orders')[0].properties.headers;
        expect(headers?.['x-resilientmq-service-id']).toEqual(expect.any(String));
        expect(headers?.['x-resilientmq-instance-id']).toEqual(expect.any(String));
    });

    it('exposes local aggregates only when requested', async () => {
        const publisher = track(new ResilientEventPublisher({
            connection: 'amqp://localhost',
            queue: 'orders',
            metricsEnabled: true
        }));
        await publisher.publish({messageId: 'metric', payload: {}});
        expect(publisher.getMetrics()?.messagesPublished).toBe(1);
    });

    function track(publisher: ResilientEventPublisher): ResilientEventPublisher {
        publishers.push(publisher);
        return publisher;
    }
});
