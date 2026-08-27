import {ResilientConsumer} from '../../../src/resilience/resilient-consumer';
import {ResilientConsumerConfig} from '../../../src/types';
import {AMQPLibMock, MockChannel} from '../../utils/amqplib-mock';

jest.mock('amqplib', () => ({connect: jest.fn()}));

describe('ResilientConsumer topology and lifecycle', () => {
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

    it('uses broker dead-letter routing for delayed retries', async () => {
        consumer = new ResilientConsumer(config());
        await consumer.start();
        const channel = (consumer as any).queue.channel as MockChannel;
        expect(channel.getQueueOptions('main')?.arguments).toMatchObject({
            'x-dead-letter-exchange': 'retry-exchange',
            'x-dead-letter-routing-key': 'retry.route'
        });
        expect(channel.getQueueOptions('retry')?.arguments).toMatchObject({
            'x-dead-letter-exchange': '',
            'x-dead-letter-routing-key': 'main',
            'x-message-ttl': 25
        });
    });

    it('binds the main, retry and dead-letter queues to their exchanges', async () => {
        consumer = new ResilientConsumer(config());
        await consumer.start();
        const channel = (consumer as any).queue.channel as MockChannel;
        expect(channel.getBindings('main')).toContain('events:orders.#');
        expect(channel.getBindings('retry')).toContain('retry-exchange:retry.route');
        expect(channel.getBindings('dead')).toContain('dead-exchange:dead.route');
    });

    it('applies single-active-consumer only when explicitly configured', async () => {
        consumer = new ResilientConsumer(config({singleActiveConsumer: true}));
        await consumer.start();
        const channel = (consumer as any).queue.channel as MockChannel;
        expect(channel.getQueueOptions('main')?.arguments?.['x-single-active-consumer']).toBe(true);
    });

    it('does not create uptime, application-heartbeat or idle-monitor intervals', async () => {
        const interval = jest.spyOn(global, 'setInterval');
        consumer = new ResilientConsumer(config());
        await consumer.start();
        expect(interval).not.toHaveBeenCalled();
        interval.mockRestore();
    });

    it('coalesces channel error and close into one recovery generation', async () => {
        consumer = new ResilientConsumer(config({reconnectDelayMs: 1}));
        await consumer.start();
        const channel = (consumer as any).queue.channel;
        channel.emit('error', new Error('failed'));
        channel.emit('close');
        await waitUntil(() => require('amqplib').connect.mock.calls.length >= 2);
        await new Promise(resolve => setTimeout(resolve, 10));
        expect(require('amqplib').connect).toHaveBeenCalledTimes(2);
    });

    it('does not install process signal handlers owned by the host application', async () => {
        const term = process.listenerCount('SIGTERM');
        const interrupt = process.listenerCount('SIGINT');
        consumer = new ResilientConsumer(config());
        await consumer.start();
        expect(process.listenerCount('SIGTERM')).toBe(term);
        expect(process.listenerCount('SIGINT')).toBe(interrupt);
    });

    it('supports repeated idempotent start and stop calls', async () => {
        consumer = new ResilientConsumer(config());
        await Promise.all([consumer.start(), consumer.start()]);
        expect(require('amqplib').connect).toHaveBeenCalledTimes(1);
        await Promise.all([consumer.stop(), consumer.stop()]);
        consumer = undefined;
    });
});

function config(overrides: Partial<ResilientConsumerConfig> = {}): ResilientConsumerConfig {
    return {
        connection: 'amqp://localhost',
        consumeQueue: {
            queue: 'main',
            exchanges: [{name: 'events', type: 'topic', routingKey: 'orders.#'}]
        },
        retryQueue: {
            queue: 'retry',
            ttlMs: 25,
            maxAttempts: 3,
            exchange: {name: 'retry-exchange', type: 'direct', routingKey: 'retry.route'}
        },
        deadLetterQueue: {
            queue: 'dead',
            exchange: {name: 'dead-exchange', type: 'direct', routingKey: 'dead.route'}
        },
        eventsToProcess: [{type: 'known', handler: async () => undefined}],
        processingTimeoutMs: 1000,
        processingLeaseMs: 2000,
        ...overrides
    };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
    const deadline = Date.now() + 250;
    while (!predicate()) {
        if (Date.now() >= deadline) throw new Error('Condition was not met before timeout');
        await new Promise(resolve => setTimeout(resolve, 2));
    }
}
