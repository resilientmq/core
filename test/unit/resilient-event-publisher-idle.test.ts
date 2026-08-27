import {ResilientEventPublisher} from '../../src/resilience/resilient-event-publisher';
import {AMQPLibMock} from '../utils/amqplib-mock';

jest.mock('amqplib', () => ({connect: jest.fn()}));

describe('ResilientEventPublisher long-lived connections', () => {
    let library: AMQPLibMock;
    let publisher: ResilientEventPublisher;

    beforeEach(() => {
        jest.useFakeTimers();
        library = new AMQPLibMock();
        require('amqplib').connect.mockImplementation((config: unknown) => library.connect(config as string));
    });

    afterEach(async () => {
        if (publisher) await publisher.disconnect();
        jest.useRealTimers();
        jest.clearAllMocks();
    });

    it('keeps the confirm connection open without runtime idle timers', async () => {
        publisher = new ResilientEventPublisher({
            connection: 'amqp://localhost',
            queue: 'orders'
        });
        await publisher.publish({messageId: 'one', payload: {}});
        jest.advanceTimersByTime(60000);
        expect(publisher.isConnected()).toBe(true);
    });

    it('reuses one long-lived connection for concurrent confirms', async () => {
        publisher = new ResilientEventPublisher({
            connection: 'amqp://localhost',
            queue: 'orders',
            maxConcurrentPublishes: 100
        });
        await Promise.all(Array.from({length: 20}, (_, index) =>
            publisher.publish({messageId: String(index), payload: {index}})
        ));
        expect(require('amqplib').connect).toHaveBeenCalledTimes(1);
        expect(library.getPublishedMessages('orders')).toHaveLength(20);
    });

    it('closes only when the owner explicitly disconnects', async () => {
        publisher = new ResilientEventPublisher({connection: 'amqp://localhost', queue: 'orders'});
        await publisher.publish({messageId: 'one', payload: {}});
        await publisher.disconnect();
        expect(publisher.isConnected()).toBe(false);
    });

    it('rejects queued publications instead of reconnecting behind disconnect', async () => {
        jest.useRealTimers();
        publisher = new ResilientEventPublisher({
            connection: 'amqp://localhost',
            queue: 'orders',
            maxConcurrentPublishes: 1,
            shutdownTimeoutMs: 20
        });
        await (publisher as any).ensureConnected();
        (publisher as any).queue.channel.setAutoConfirm(false);
        const first = publisher.publish({messageId: 'first', payload: {}}).catch(error => error as Error);
        await new Promise(resolve => setImmediate(resolve));
        const waiting = publisher.publish({messageId: 'waiting', payload: {}}).catch(error => error as Error);
        await new Promise(resolve => setImmediate(resolve));
        await publisher.disconnect();
        expect(await first).toBeInstanceOf(Error);
        await expect(waiting).resolves.toEqual(expect.objectContaining({message: expect.stringContaining('disconnect')}));
        expect(require('amqplib').connect).toHaveBeenCalledTimes(1);
        expect(library.getPublishedMessages('orders')).toHaveLength(1);
    });
});
