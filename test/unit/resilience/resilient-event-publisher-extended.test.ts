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

        it('should handle processPendingEvents when one event fails to publish', async () => {
            let publishCount = 0;
            const AmqpQueue = require('../../../src/broker/amqp-queue').AmqpQueue;
            AmqpQueue.mockImplementation(() => ({
                connect: jest.fn().mockResolvedValue(undefined),
                disconnect: jest.fn().mockResolvedValue(undefined),
                publish: jest.fn().mockImplementation(async () => {
                    publishCount++;
                    if (publishCount === 2) {
                        throw new Error('Publish failed for event 2');
                    }
                }),
                closed: false
            }));

            config.instantPublish = false;
            publisher = new ResilientEventPublisher(config);

            // Store multiple pending events
            const event1 = { ...testEvent, messageId: 'msg-001' };
            const event2 = { ...testEvent, messageId: 'msg-002' };
            const event3 = { ...testEvent, messageId: 'msg-003' };
            await publisher.publish(event1, { storeOnly: true });
            await publisher.publish(event2, { storeOnly: true });
            await publisher.publish(event3, { storeOnly: true });

            // Process pending events — event 2 will fail
            await publisher.processPendingEvents();

            // Event 1 and 3 should be published, event 2 should be ERROR
            const saved1 = await mockStore.getEvent(event1);
            const saved2 = await mockStore.getEvent(event2);
            const saved3 = await mockStore.getEvent(event3);

            expect(saved1?.status).toBe(EventPublishStatus.PUBLISHED);
            expect(saved2?.status).toBe(EventPublishStatus.ERROR);
            expect(saved3?.status).toBe(EventPublishStatus.PUBLISHED);
        });

        it('should throw processPendingEvents when store lacks getPendingEvents', async () => {
            config.store = {
                saveEvent: jest.fn(),
                getEvent: jest.fn(),
                updateEventStatus: jest.fn(),
            } as any;

            publisher = new ResilientEventPublisher(config);

            await expect(publisher.processPendingEvents()).rejects.toThrow(
                'Store must implement getPendingEvents() method'
            );
        });
    });

    describe('connection recovery', () => {
        it('should reconnect when queue was closed', async () => {
            const mockConnect = jest.fn().mockResolvedValue(undefined);
            const AmqpQueue = require('../../../src/broker/amqp-queue').AmqpQueue;

            let queueInstance: any;
            AmqpQueue.mockImplementation(() => {
                queueInstance = {
                    connect: mockConnect,
                    disconnect: jest.fn().mockResolvedValue(undefined),
                    publish: jest.fn().mockResolvedValue(undefined),
                    closed: false
                };
                return queueInstance;
            });

            publisher = new ResilientEventPublisher(config);

            // First publish establishes connection
            await publisher.publish(testEvent);
            expect(mockConnect).toHaveBeenCalledTimes(1);

            // Simulate connection closed
            queueInstance.closed = true;

            // Second publish should trigger reconnection
            const event2 = { ...testEvent, messageId: 'msg-002' };
            await publisher.publish(event2);

            // Should have connected again
            expect(mockConnect).toHaveBeenCalledTimes(2);
        });

        it('should handle concurrent publishing without deadlock', async () => {
            const AmqpQueue = require('../../../src/broker/amqp-queue').AmqpQueue;
            AmqpQueue.mockImplementation(() => ({
                connect: jest.fn().mockResolvedValue(undefined),
                disconnect: jest.fn().mockResolvedValue(undefined),
                publish: jest.fn().mockImplementation(() => new Promise(resolve => setTimeout(resolve, 10))),
                closed: false
            }));

            publisher = new ResilientEventPublisher(config);

            const events = Array.from({ length: 10 }, (_, i) => ({
                ...testEvent,
                messageId: `msg-${i}`
            }));

            // All should eventually complete
            await Promise.all(events.map(event => publisher.publish(event)));

            expect(mockStore.getCallCount('saveEvent')).toBe(10);
        });
    });
});

describe('ResilientEventPublisher - Metrics', () => {
    let mockStore: EventStoreMock;

    beforeEach(() => {
        mockStore = new EventStoreMock();
        const AmqpQueue = require('../../../src/broker/amqp-queue').AmqpQueue;
        AmqpQueue.mockImplementation(() => ({
            connect: jest.fn().mockResolvedValue(undefined),
            disconnect: jest.fn().mockResolvedValue(undefined),
            publish: jest.fn().mockResolvedValue(undefined),
            closed: false,
        }));
    });

    afterEach(() => {
        mockStore.clear();
        jest.clearAllMocks();
    });

    it('should return undefined from getMetrics() when metricsEnabled is false', () => {
        const pub = new ResilientEventPublisher({
            connection: 'amqp://localhost',
            queue: 'q',
            store: mockStore,
        });
        expect(pub.getMetrics()).toBeUndefined();
    });

    it('should return a snapshot from getMetrics() when metricsEnabled is true', () => {
        const pub = new ResilientEventPublisher({
            connection: 'amqp://localhost',
            queue: 'q',
            store: mockStore,
            metricsEnabled: true,
        });
        const snap = pub.getMetrics();
        expect(snap).toBeDefined();
        expect(snap!.messagesPublished).toBe(0);
    });

    it('should increment messagesPublished on successful publish', async () => {
        const pub = new ResilientEventPublisher({
            connection: 'amqp://localhost',
            queue: 'q',
            store: mockStore,
            metricsEnabled: true,
        });

        const event: EventMessage = { messageId: 'pub-1', type: 'test', payload: {}, properties: {} };
        await pub.publish(event);

        const snap = pub.getMetrics()!;
        expect(snap.messagesPublished).toBe(1);
        expect(snap.processingErrors).toBe(0);

        await pub.disconnect();
    });

    it('should increment processingErrors on publish failure', async () => {
        const AmqpQueue = require('../../../src/broker/amqp-queue').AmqpQueue;
        AmqpQueue.mockImplementationOnce(() => ({
            connect: jest.fn().mockRejectedValue(new Error('conn fail')),
            disconnect: jest.fn().mockResolvedValue(undefined),
            publish: jest.fn().mockResolvedValue(undefined),
            closed: false,
        }));

        const pub = new ResilientEventPublisher({
            connection: 'amqp://localhost',
            queue: 'q',
            store: mockStore,
            metricsEnabled: true,
        });

        const event: EventMessage = { messageId: 'pub-err', type: 'test', payload: {}, properties: {} };
        try { await pub.publish(event); } catch { /* expected */ }

        const snap = pub.getMetrics()!;
        expect(snap.processingErrors).toBe(1);
        expect(snap.messagesPublished).toBe(0);
    });
});
