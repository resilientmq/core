import {AmqpQueue} from '../../../src/broker/amqp-queue';
import {AMQPLibMock, MockChannel} from '../../utils/amqplib-mock';

jest.mock('amqplib', () => ({connect: jest.fn()}));

describe('AmqpQueue confirmed transport', () => {
    let library: AMQPLibMock;
    let queue: AmqpQueue;

    beforeEach(() => {
        library = new AMQPLibMock();
        require('amqplib').connect.mockImplementation((config: unknown) => library.connect(config as string));
        queue = new AmqpQueue('amqp://localhost');
    });

    afterEach(async () => {
        if (!queue.closed) await queue.forceClose();
        jest.clearAllMocks();
    });

    it('creates a confirm channel and applies the requested prefetch', async () => {
        await queue.connect(1000);
        expect(queue.prefetchCount).toBe(1000);
        expect(queue.channel).toBeDefined();
        expect(queue.closed).toBe(false);
    });

    it('adds an AMQP heartbeat when the URI omits one', async () => {
        await queue.connect();
        expect(require('amqplib').connect).toHaveBeenCalledWith(expect.stringContaining('heartbeat=10'));
    });

    it('rejects invalid prefetch before opening a connection', async () => {
        await expect(queue.connect(-1)).rejects.toThrow('Prefetch');
        expect(require('amqplib').connect).not.toHaveBeenCalled();
    });

    it('does not resolve a publication before its broker confirm', async () => {
        await queue.connect();
        const channel = queue.channel as unknown as MockChannel;
        channel.setAutoConfirm(false);
        let resolved = false;
        const publication = queue.publish('orders', {messageId: '1', payload: {ok: true}})
            .then(() => { resolved = true; });
        await Promise.resolve();
        expect(resolved).toBe(false);
        channel.confirmPending();
        await publication;
        expect(resolved).toBe(true);
    });

    it('rejects a negative publisher confirm', async () => {
        await queue.connect();
        (queue.channel as unknown as MockChannel).failNextConfirm();
        await expect(queue.publish('orders', {messageId: '2', payload: {}})).rejects.toThrow('confirm failed');
    });

    it('rejects a mandatory publication returned as unroutable', async () => {
        await queue.connect();
        (queue.channel as unknown as MockChannel).returnNextPublication();
        await expect(queue.publish('missing', {messageId: '3', payload: {}})).rejects.toThrow('unroutable');
    });

    it('waits for channel drain when RabbitMQ applies backpressure', async () => {
        await queue.connect();
        (queue.channel as unknown as MockChannel).applyBackpressureNext();
        await expect(queue.publish('orders', {messageId: '4', payload: {}})).resolves.toBeUndefined();
    });

    it('blocks later writes behind one shared channel drain gate', async () => {
        await queue.connect();
        const channel = queue.channel as unknown as MockChannel;
        const send = jest.spyOn(channel, 'sendToQueue');
        channel.applyBackpressureNext();
        const first = queue.publish('orders', {messageId: 'backpressure-1', payload: {}});
        const second = queue.publish('orders', {messageId: 'backpressure-2', payload: {}});
        await Promise.resolve();
        expect(send).toHaveBeenCalledTimes(1);
        await Promise.all([first, second]);
        expect(send).toHaveBeenCalledTimes(2);
    });

    it('preserves headers and adds publication correlation metadata', async () => {
        await queue.connect();
        await queue.publish('orders', {
            messageId: '5',
            type: 'order.created',
            payload: {id: 5},
            properties: {headers: {trace: 'abc'}}
        });
        const [message] = library.getPublishedMessages('orders');
        expect(message.properties.headers).toMatchObject({
            trace: 'abc',
            'x-message-id': '5',
            'x-event-type': 'order.created'
        });
        expect(message.properties.headers?.['x-resilientmq-publication-id']).toEqual(expect.any(String));
        expect(message.properties.deliveryMode).toBe(2);
    });

    it('acknowledges a raw delivery only when the handler requests it', async () => {
        await queue.connect();
        const ack = jest.spyOn(queue.channel, 'ack');
        await queue.consumeRaw('orders', async delivery => {
            expect(JSON.parse(delivery.content.toString())).toEqual({id: 1});
            return 'ack';
        });
        (queue.channel as unknown as MockChannel).simulateIncomingMessage('orders', {id: 1});
        await new Promise(resolve => setImmediate(resolve));
        expect(ack).toHaveBeenCalledTimes(1);
    });

    it.each([
        ['reject', false],
        ['requeue', true]
    ] as const)('maps %s to the expected nack requeue flag', async (disposition, requeue) => {
        await queue.connect();
        const nack = jest.spyOn(queue.channel, 'nack');
        await queue.consumeRaw('orders', async () => disposition);
        (queue.channel as unknown as MockChannel).simulateIncomingMessage('orders', {});
        await new Promise(resolve => setImmediate(resolve));
        expect(nack).toHaveBeenCalledWith(expect.anything(), false, requeue);
    });

    it('marks both channel and connection loss as unavailable', async () => {
        await queue.connect();
        const listener = jest.fn();
        queue.onDisconnect(listener);
        queue.channel.emit('error', new Error('channel failed'));
        expect(queue.closed).toBe(true);
        expect(listener).toHaveBeenCalledWith(expect.objectContaining({source: 'channel'}));
    });

    it('cancels consumers before closing the channel', async () => {
        await queue.connect();
        await queue.consumeRaw('orders', async () => 'ack');
        const cancel = jest.spyOn(queue.channel, 'cancel');
        const close = jest.spyOn(queue.channel, 'close');
        await queue.disconnect();
        expect(cancel).toHaveBeenCalled();
        expect(cancel.mock.invocationCallOrder[0]).toBeLessThan(close.mock.invocationCallOrder[0]);
    });
});
