import { ResilientEventPublisher } from '../../../src/resilience/resilient-event-publisher';
import { EventStoreMock } from '../../utils/event-store-mock';
import { ResilientPublisherConfig, EventMessage, EventPublishStatus } from '../../../src/types';

// Mock the AmqpQueue
jest.mock('../../../src/broker/amqp-queue', () => {
    return {
        AmqpQueue: jest.fn().mockImplementation(() => ({
            connect: jest.fn().mockResolvedValue(undefined),
            disconnect: jest.fn().mockResolvedValue(undefined),
            publish: jest.fn().mockResolvedValue(undefined),
            closed: false
        }))
    };
});

describe('ResilientEventPublisher - Extended Tests', () => {
    let publisher: ResilientEventPublisher;
    let mockStore: EventStoreMock;
    let config: ResilientPublisherConfig;
    let testEvent: EventMessage;

    beforeEach(() => {
        mockStore = new EventStoreMock();

        testEvent = {
            messageId: 'msg-001',
            type: 'test.event',
            payload: { data: 'test' },
            properties: {}
        };

        config = {
            connection: 'amqp://localhost:5672',
            queue: 'test.queue',
            instantPublish: true,
            store: mockStore
        };
    });

    afterEach(async () => {
        if (publisher) {
            try {
                await publisher.disconnect();
            } catch (e) {
                // Ignore cleanup errors
            }
        }
        mockStore.clear();
        jest.clearAllMocks();
    });

    describe('concurrent publishing', () => {
        it('should handle concurrent publish operations', async () => {
            publisher = new ResilientEventPublisher(config);

            const events = Array.from({ length: 5 }, (_, i) => ({
                ...testEvent,
                messageId: `msg-${i}`
            }));

            await Promise.all(events.map(event => publisher.publish(event)));

            expect(mockStore.getCallCount('saveEvent')).toBe(5);
        });

        it('should publish multiple events sequentially', async () => {
            publisher = new ResilientEventPublisher(config);

            const events = Array.from({ length: 3 }, (_, i) => ({
                ...testEvent,
                messageId: `msg-${i}`
            }));

            for (const event of events) {
                await publisher.publish(event);
            }

            expect(mockStore.getCallCount('saveEvent')).toBe(3);
        });
    });

    describe('store connection validation', () => {
        it('should validate store connection before publishing', async () => {
            publisher = new ResilientEventPublisher(config);

            const getEventSpy = jest.spyOn(mockStore, 'getEvent');
            
            await publisher.publish(testEvent);

            expect(getEventSpy).toHaveBeenCalled();
        });

        it('should check for duplicate messages', async () => {
            publisher = new ResilientEventPublisher(config);

            await publisher.publish(testEvent);
            await publisher.publish(testEvent); // Same message ID

            // Should only save once (duplicate detected)
            expect(mockStore.getCallCount('saveEvent')).toBe(1);
        });
    });

    describe('pending events processing', () => {
        it('should store events when storeOnly is true', async () => {
            config.instantPublish = false;
            publisher = new ResilientEventPublisher(config);

            await publisher.publish(testEvent, { storeOnly: true });

            const saved = await mockStore.getEvent(testEvent);
            expect(saved?.status).toBe(EventPublishStatus.PENDING);
        });

        it('should not process pending events when store is not configured', async () => {
            config.store = undefined;
            publisher = new ResilientEventPublisher(config);

            await expect(publisher.processPendingEvents()).resolves.not.toThrow();
        });
    });

    describe('configuration', () => {
        it('should support idle timeout configuration', async () => {
            config.idleTimeoutMs = 100;
            publisher = new ResilientEventPublisher(config);

            await publisher.publish(testEvent);

            expect(publisher.isConnected()).toBe(true);
        });

        it('should support exchange configuration', async () => {
            config.queue = undefined;
            config.exchange = {
                name: 'events.exchange',
                type: 'topic',
                options: { durable: true }
            };

            publisher = new ResilientEventPublisher(config);

            const eventWithRouting = {
                ...testEvent,
                routingKey: 'user.created'
            };

            await publisher.publish(eventWithRouting);

            expect(publisher.isConnected()).toBe(true);
        });
    });

    describe('error handling', () => {
        it('should handle publish errors', async () => {
            const AmqpQueue = require('../../../src/broker/amqp-queue').AmqpQueue;
            AmqpQueue.mockImplementationOnce(() => ({
                connect: jest.fn().mockRejectedValue(new Error('Connection failed')),
                disconnect: jest.fn().mockResolvedValue(undefined),
                publish: jest.fn().mockResolvedValue(undefined),
                closed: false
            }));

            publisher = new ResilientEventPublisher(config);

            await expect(publisher.publish(testEvent)).rejects.toThrow('Connection failed');

            const savedEvent = await mockStore.getEvent(testEvent);
            expect(savedEvent?.status).toBe(EventPublishStatus.ERROR);
        });
    });
});
