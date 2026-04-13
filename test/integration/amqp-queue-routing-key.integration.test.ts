import amqplib from 'amqplib';
import { AmqpQueue } from '../../src/broker/amqp-queue';
import { EventConsumeStatus } from '../../src/types';
import { TestContainersManager } from '../utils/test-containers';
import { uniqueQueueName } from './test-config';

/**
 * Verifies AmqpQueue.consume passes through routingKey from broker message fields.
 * Requires Docker for Testcontainers.
 */
describe('Integration: AmqpQueue routingKey', () => {
    let containerManager: TestContainersManager;
    let connectionUrl: string;

    beforeAll(async () => {
        containerManager = new TestContainersManager();
        await containerManager.startRabbitMQ();
        connectionUrl = containerManager.getConnectionUrl();
    }, 60000);

    afterAll(async () => {
        await containerManager.stopAll();
    }, 30000);

    it('should expose the routing key on consumed events for topic exchange publishes', async () => {
        const queueName = uniqueQueueName('test.amqp.routing');
        const exchangeName = `test.amqp.routing.ex.${Date.now()}`;

        const setupConn = await amqplib.connect(connectionUrl);
        const setupCh = await setupConn.createChannel();
        await setupCh.assertExchange(exchangeName, 'topic', { durable: false });
        await setupCh.assertQueue(queueName, { durable: false, autoDelete: true });
        await setupCh.bindQueue(queueName, exchangeName, 'orders.*');
        await setupCh.close();
        await setupConn.close();

        const amqpQueue = new AmqpQueue(connectionUrl);
        await amqpQueue.connect(1);

        let received: { routingKey?: string; payload: unknown } | null = null;
        await amqpQueue.consume(queueName, async (event) => {
            received = { routingKey: event.routingKey, payload: event.payload };
        });

        await new Promise((resolve) => setTimeout(resolve, 300));

        const event = {
            messageId: `int-rk-${Date.now()}`,
            type: 'order.created',
            payload: { orderId: 'ord-1' },
            status: EventConsumeStatus.RECEIVED,
            routingKey: 'orders.created'
        };

        await amqpQueue.publish('unused', event, {
            exchange: {
                name: exchangeName,
                type: 'topic',
                options: { durable: false }
            }
        });

        const deadline = Date.now() + 10000;
        while (!received && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 150));
        }

        expect(received).not.toBeNull();
        expect(received!.routingKey).toBe('orders.created');
        expect(received!.payload).toEqual({ orderId: 'ord-1' });

        await amqpQueue.disconnect();
    }, 30000);
});
