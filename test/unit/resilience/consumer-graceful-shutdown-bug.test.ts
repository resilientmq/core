import {ResilientConsumer} from '../../../src/resilience/resilient-consumer';
import {AMQPLibMock, MockChannel} from '../../utils/amqplib-mock';

jest.mock('amqplib', () => ({connect: jest.fn()}));

describe('ResilientConsumer bounded shutdown', () => {
    let library: AMQPLibMock;

    beforeEach(() => {
        library = new AMQPLibMock();
        require('amqplib').connect.mockImplementation((config: unknown) => library.connect(config as string));
    });

    it('cancels new deliveries and force-closes when a handler ignores AbortSignal', async () => {
        const consumer = new ResilientConsumer({
            connection: 'amqp://localhost',
            consumeQueue: {queue: 'main'},
            retryQueue: {queue: 'retry'},
            eventsToProcess: [{type: 'known', handler: async () => new Promise<void>(() => undefined)}],
            processingTimeoutMs: 1000,
            processingLeaseMs: 2000,
            shutdownTimeoutMs: 5
        });
        await consumer.start();
        const queue = (consumer as any).queue;
        const channel = queue.channel as MockChannel;
        const cancel = jest.spyOn(channel, 'cancel');
        const close = jest.spyOn(channel, 'close');
        channel.simulateIncomingMessage('main', {}, {messageId: 'stuck', type: 'known'});
        await new Promise(resolve => setImmediate(resolve));
        const startedAt = Date.now();
        await consumer.stop();
        expect(Date.now() - startedAt).toBeLessThan(250);
        expect(cancel).toHaveBeenCalled();
        expect(close).toHaveBeenCalled();
        expect(queue.closed).toBe(true);
    });
});
