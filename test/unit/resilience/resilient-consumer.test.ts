import {ResilientConsumer} from '../../../src/resilience/resilient-consumer';
import {EventConsumeStatus, ResilientConsumerConfig} from '../../../src/types';
import {AMQPLibMock, MockChannel} from '../../utils/amqplib-mock';
import {EventStoreMock} from '../../utils/event-store-mock';

jest.mock('amqplib', () => ({connect: jest.fn()}));

describe('ResilientConsumer runtime', () => {
    let library: AMQPLibMock;
    let consumer: ResilientConsumer | undefined;

    beforeEach(() => {
        library = new AMQPLibMock();
        require('amqplib').connect.mockImplementation((config: unknown) => library.connect(config as string));
    });

    afterEach(async () => {
        await consumer?.stop();
        consumer = undefined;
        jest.clearAllMocks();
    });

    it('validates queue, handlers, prefetch and lease ordering', () => {
        expect(() => new ResilientConsumer(config({consumeQueue: {queue: ''}}))).toThrow('consumeQueue.queue');
        expect(() => new ResilientConsumer(config({eventsToProcess: []}))).toThrow('eventsToProcess');
        expect(() => new ResilientConsumer(config({prefetch: -1}))).toThrow('prefetch');
        expect(() => new ResilientConsumer(config({processingTimeoutMs: 50, processingLeaseMs: 50})))
            .toThrow('processingLeaseMs');
        expect(() => new ResilientConsumer(config({retryQueue: {queue: 'retry', maxAttempts: 0}})))
            .toThrow('maxAttempts');
        expect(() => new ResilientConsumer(config({reconnectDelayMs: 10, reconnectMaxDelayMs: 5})))
            .toThrow('reconnectMaxDelayMs');
        expect(() => new ResilientConsumer(config({processingTimeoutMs: Number.NaN})))
            .toThrow('processingLeaseMs');
        expect(() => new ResilientConsumer(config({
            store: {
                saveEvent: jest.fn(),
                updateEventStatus: jest.fn(),
                getEvent: jest.fn(),
                deleteEvent: jest.fn()
            }
        }))).toThrow('atomic claimConsumeEvent');
    });

    it('applies high prefetch directly to the active channel', async () => {
        consumer = new ResilientConsumer(config({prefetch: 10000}));
        await consumer.start();
        expect((consumer as any).queue.prefetchCount).toBe(10000);
    });

    it('processes a raw delivery and acknowledges it after durable completion', async () => {
        const handler = jest.fn();
        const store = new EventStoreMock();
        consumer = new ResilientConsumer(config({store, eventsToProcess: [{type: 'known', handler}]}));
        await consumer.start();
        const queue = (consumer as any).queue;
        const ack = jest.spyOn(queue.channel, 'ack');
        (queue.channel as MockChannel).simulateIncomingMessage('main', {value: 1}, {
            messageId: 'consume-one',
            type: 'known'
        });
        await new Promise(resolve => setImmediate(resolve));
        expect(handler).toHaveBeenCalledTimes(1);
        expect(ack).toHaveBeenCalledTimes(1);
        expect((await store.getEvent({messageId: 'consume-one', payload: null}))?.status).toBe(EventConsumeStatus.DONE);
    });

    it('fails startup when the store cannot pass its bounded health check', async () => {
        const store = new EventStoreMock();
        store.setFailOnGet(true);
        consumer = new ResilientConsumer(config({
            store,
            storeConnectionRetries: 1,
            storeConnectionRetryDelayMs: 1
        }));
        await expect(consumer.start()).rejects.toThrow('Failed to connect to store');
    });

    it('recovers from a connection error using lifecycle events instead of polling', async () => {
        consumer = new ResilientConsumer(config({reconnectDelayMs: 1, reconnectMaxDelayMs: 5}));
        await consumer.start();
        const firstConnection = (consumer as any).queue.connection;
        firstConnection.emit('error', new Error('socket lost'));
        await waitUntil(() => require('amqplib').connect.mock.calls.length >= 2);
        expect((consumer as any).queue.closed).toBe(false);
    });

    it('keeps retrying recovery until RabbitMQ is available again', async () => {
        consumer = new ResilientConsumer(config({reconnectDelayMs: 1, reconnectMaxDelayMs: 4}));
        await consumer.start();
        library.setConnectionFailure(true);
        (consumer as any).queue.connection.emit('error', new Error('network partition'));
        await waitUntil(() => require('amqplib').connect.mock.calls.length >= 3);
        library.setConnectionFailure(false);
        await waitUntil(() => (consumer as any).queue && !(consumer as any).queue.closed, 500);
        expect(require('amqplib').connect.mock.calls.length).toBeGreaterThanOrEqual(4);
    });

    it('aborts active handlers before bounded shutdown closes the channel', async () => {
        const aborted = jest.fn();
        const handler = jest.fn((_event: unknown, context: {signal: AbortSignal}) =>
            new Promise<void>(resolve => context.signal.addEventListener('abort', () => {
                aborted();
                resolve();
            }))
        );
        consumer = new ResilientConsumer(config({
            eventsToProcess: [{type: 'known', handler}],
            shutdownTimeoutMs: 100
        }));
        await consumer.start();
        const channel = (consumer as any).queue.channel as MockChannel;
        channel.simulateIncomingMessage('main', {}, {messageId: 'active', type: 'known'});
        await new Promise(resolve => setImmediate(resolve));
        await consumer.stop();
        expect(aborted).toHaveBeenCalledTimes(1);
        expect(consumer.processingCount).toBe(0);
        consumer = undefined;
    });

    it('does not mutate global RETRY rows owned by other replicas during shutdown', async () => {
        const store = new EventStoreMock();
        await store.saveEvent({messageId: 'other', payload: {}, status: EventConsumeStatus.RETRY});
        consumer = new ResilientConsumer(config({store}));
        await consumer.start();
        await consumer.stop();
        expect((await store.getEvent({messageId: 'other', payload: null}))?.status).toBe(EventConsumeStatus.RETRY);
        expect(store.getCallCount('getEventsByStatus')).toBe(0);
        consumer = undefined;
    });

    it('collects consumer metrics only when enabled', async () => {
        consumer = new ResilientConsumer(config({metricsEnabled: true}));
        await consumer.start();
        const channel = (consumer as any).queue.channel as MockChannel;
        channel.simulateIncomingMessage('main', {}, {messageId: 'metric', type: 'known'});
        await new Promise(resolve => setImmediate(resolve));
        expect(consumer.getMetrics()).toEqual(expect.objectContaining({
            messagesReceived: 1,
            messagesProcessed: 1
        }));
    });

    it('waits for an active stop before starting a new generation', async () => {
        consumer = new ResilientConsumer(config());
        await consumer.start();
        const firstQueue = (consumer as any).queue;
        jest.spyOn(firstQueue, 'waitForProcessing').mockImplementation(async () => {
            await new Promise(resolve => setTimeout(resolve, 10));
            return true;
        });
        const stopping = consumer.stop();
        const restarting = consumer.start();
        await Promise.all([stopping, restarting]);
        expect((consumer as any).queue).not.toBe(firstQueue);
        expect((consumer as any).desiredRunning).toBe(true);
    });
});

function config(overrides: Partial<ResilientConsumerConfig> = {}): ResilientConsumerConfig {
    return {
        connection: 'amqp://localhost',
        serviceId: 'consumer-service',
        consumeQueue: {queue: 'main'},
        retryQueue: {queue: 'retry', ttlMs: 5, maxAttempts: 3},
        deadLetterQueue: {queue: 'dead'},
        eventsToProcess: [{type: 'known', handler: async () => undefined}],
        processingTimeoutMs: 1000,
        processingLeaseMs: 2000,
        ...overrides
    };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 250): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() >= deadline) throw new Error('Condition was not met before timeout');
        await new Promise(resolve => setTimeout(resolve, 2));
    }
}
