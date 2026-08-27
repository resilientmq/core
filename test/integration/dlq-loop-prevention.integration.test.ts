import {ResilientConsumer} from '../../src/resilience/resilient-consumer';
import {ResilientEventPublisher} from '../../src/resilience/resilient-event-publisher';
import {TestContainersManager} from '../utils/test-containers';
import {EventStoreMock} from '../utils/event-store-mock';
import {RabbitMQHelpers} from '../utils/rabbitmq-helpers';
import {uniqueQueueName} from './test-config';

describe('Integration: bounded broker-owned retries', () => {
    let containers: TestContainersManager;
    let connection: string;
    let helpers: RabbitMQHelpers;
    let consumer: ResilientConsumer | undefined;
    let publisher: ResilientEventPublisher | undefined;

    beforeAll(async () => {
        containers = new TestContainersManager();
        await containers.startRabbitMQ();
        connection = containers.getConnectionUrl();
        helpers = new RabbitMQHelpers(connection);
    }, 60000);

    afterEach(async () => {
        await consumer?.stop();
        await publisher?.disconnect();
        consumer = undefined;
        publisher = undefined;
    });

    afterAll(async () => {
        await helpers.disconnect();
        await containers.stopAll();
    }, 30000);

    it('does not trust a publisher-supplied x-retry-count header', async () => {
        const queue = uniqueQueueName('retry-header-isolation');
        const handler = jest.fn();
        consumer = createConsumer(queue, handler);
        publisher = createPublisher(queue);
        await consumer.start();
        await publisher.publish({
            messageId: 'application-header',
            type: 'known',
            payload: {},
            properties: {headers: {'x-retry-count': 999999}}
        });
        await waitUntil(() => handler.mock.calls.length === 1);
        expect(await helpers.getMessageCount(`${queue}.dead`)).toBe(0);
    });

    it('keeps the original recoverable when the terminal store transition fails', async () => {
        const queue = uniqueQueueName('store-failure-terminal');
        const store = new EventStoreMock();
        store.setFailOnUpdate(true);
        const handler = jest.fn().mockRejectedValue(new Error('handler failed'));
        consumer = createConsumer(queue, handler, store);
        publisher = createPublisher(queue);
        await consumer.start();
        await publisher.publish({messageId: 'terminal', type: 'known', payload: {}});
        await waitUntil(async () => await helpers.getMessageCount(`${queue}.dead`) === 1, 5000);
        expect(handler).toHaveBeenCalledTimes(3);
        const [message] = await helpers.peekMessages(`${queue}.dead`, 1);
        expect(message.properties.headers['x-resilientmq-attempt']).toBe(3);
        expect(message.properties.headers['x-death']).toEqual(expect.any(Array));
        await consumer.stop();
        consumer = undefined;
        await waitUntil(async () => await helpers.getMessageCount(queue) === 1);
        expect((await store.getEvent({messageId: 'terminal', payload: null}))?.status).toBe('PROCESSING');
    });

    it('keeps the original recoverable until an unavailable DLQ can confirm publication', async () => {
        const queue = uniqueQueueName('dlq-confirm-recovery');
        const handler = jest.fn().mockRejectedValue(new Error('handler failed'));
        consumer = createConsumer(queue, handler);
        publisher = createPublisher(queue);
        await consumer.start();
        await helpers.deleteQueue(`${queue}.dead`);
        await publisher.publish({messageId: 'recoverable', type: 'known', payload: {}});
        await waitUntil(() => handler.mock.calls.length === 3, 5000);
        await new Promise(resolve => setTimeout(resolve, 300));
        expect(handler).toHaveBeenCalledTimes(3);
        await helpers.assertQueue(`${queue}.dead`);
        await waitUntil(async () => await helpers.getMessageCount(`${queue}.dead`) === 1, 5000);
        expect(await helpers.getMessageCount(queue)).toBe(0);
        expect(await helpers.getMessageCount(`${queue}.retry`)).toBe(0);
    });

    function createConsumer(queue: string, handler: jest.Mock, store?: EventStoreMock): ResilientConsumer {
        return new ResilientConsumer({
            connection,
            serviceId: 'integration-consumer',
            consumeQueue: {queue},
            retryQueue: {queue: `${queue}.retry`, ttlMs: 100, maxAttempts: 3},
            deadLetterQueue: {queue: `${queue}.dead`},
            eventsToProcess: [{type: 'known', handler}],
            store,
            processingTimeoutMs: 1000,
            processingLeaseMs: 2000
        });
    }

    function createPublisher(queue: string): ResilientEventPublisher {
        return new ResilientEventPublisher({connection, queue});
    }
});

async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs = 3000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!(await predicate())) {
        if (Date.now() >= deadline) throw new Error('Condition was not met before timeout');
        await new Promise(resolve => setTimeout(resolve, 25));
    }
}
