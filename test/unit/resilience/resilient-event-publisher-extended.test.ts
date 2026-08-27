import {ResilientEventPublisher} from '../../../src/resilience/resilient-event-publisher';
import {BufferedMetricsSink, ResilienceMetricEvent} from '../../../src/metrics/metrics-collector';
import {AMQPLibMock} from '../../utils/amqplib-mock';

jest.mock('amqplib', () => ({connect: jest.fn()}));

describe('ResilientEventPublisher observability', () => {
    let library: AMQPLibMock;
    let publisher: ResilientEventPublisher;

    beforeEach(() => {
        library = new AMQPLibMock();
        require('amqplib').connect.mockImplementation((config: unknown) => library.connect(config as string));
    });

    afterEach(async () => {
        if (publisher) await publisher.disconnect();
        jest.clearAllMocks();
    });

    it('emits one compact event after a confirmed publication', async () => {
        const events: ResilienceMetricEvent[] = [];
        publisher = new ResilientEventPublisher({
            connection: 'amqp://localhost',
            queue: 'orders',
            metricsSink: {emit: event => { events.push(event); }}
        });
        await publisher.publish({messageId: 'metric', payload: {}});
        expect(events).toContainEqual(expect.objectContaining({
            name: 'publish.confirmed',
            messageId: 'metric',
            serviceId: expect.any(String),
            instanceId: expect.any(String)
        }));
    });

    it('does not let a failing metrics backend affect delivery correctness', async () => {
        publisher = new ResilientEventPublisher({
            connection: 'amqp://localhost',
            queue: 'orders',
            metricsSink: {emit: async () => { throw new Error('metrics unavailable'); }}
        });
        await expect(publisher.publish({messageId: 'safe', payload: {}})).resolves.toBeUndefined();
        expect(library.getPublishedMessages('orders')).toHaveLength(1);
    });

    it('buffers storage-backed metric work outside the publication path', async () => {
        const stored: string[] = [];
        const sink = new BufferedMetricsSink({
            emit: async event => {
                await new Promise(resolve => setTimeout(resolve, 2));
                stored.push(event.name);
            }
        });
        const startedAt = Date.now();
        sink.emit({name: 'publish.confirmed', timestamp: Date.now(), messageId: 'one'});
        expect(Date.now() - startedAt).toBeLessThan(20);
        await sink.flush();
        expect(stored).toEqual(['publish.confirmed']);
    });
});
