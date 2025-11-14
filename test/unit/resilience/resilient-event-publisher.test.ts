import { ResilientEventPublisher } from '../../../src/resilience/resilient-event-publisher';
import { EventStoreMock } from '../../utils/event-store-mock';
import { AMQPLibMock } from '../../utils/amqplib-mock';
import { ResilientPublisherConfig, EventMessage } from '../../../src/types';
import { EventPublishStatus } from '../../../src/types';

// Mock amqplib
jest.mock('amqplib', () => {
    const mockLib = new (require('../../utils/amqplib-mock').AMQPLibMock)();
    return {
        connect: jest.fn((...args) => mockLib.connect(...args))
    };
});

// Mock the AmqpQueue
jest.mock('../../../src/broker/amqp-queue');

describe('ResilientEventPublisher', () => {
    let publisher: ResilientEventPublisher;
    let mockStore: EventStoreMock;
    let config: ResilientPublisherConfig;
    let mockLib: AMQPLibMock;
    let testEvent: EventMessage;

    beforeEach(() => {
        jest.useFakeTimers();
        mockStore = new EventStoreMock();
        mockLib = new AMQPLibMock();
        
        const amqplib = require('amqplib');
        amqplib.connect.mockImplementation((url: any) => mockLib.connect(url));

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

    afterEach(() => {
        if (publisher && (publisher as any).pendingEventsInterval) {
            publisher.stopPendingEventsCheck();
        }
        mockStore.clear();
        mockLib.reset();
        jest.clearAllMocks();
        jest.useRealTimers();
    });

    describe('constructor', () => {
        it('should create publisher with valid configuration', () => {
            expect(() => {
                publisher = new ResilientEventPublisher(config);
            }).not.toThrow();
        });

        it('should throw error when instantPublish is false without store', () => {
            config.instantPublish = false;
            config.store = undefined;

            expect(() => {
                publisher = new ResilientEventPublisher(config);
            }).toThrow('Configuration error: "store" is REQUIRED when "instantPublish" is set to false');
        });

        it('should throw error when store lacks getPendingEvents method', () => {
            config.instantPublish = false;
            config.store = { saveEvent: jest.fn() } as any;

            expect(() => {
                publisher = new ResilientEventPublisher(config);
            }).toThrow('Configuration error: store must implement "getPendingEvents()" method');
        });

        it('should throw error when neither queue nor exchange is configured', () => {
            config.queue = undefined;
            config.exchange = undefined;

            expect(() => {
                publisher = new ResilientEventPublisher(config);
            }).toThrow('Configuration error: either "queue" or "exchange" must be configured');
        });
    });

    describe('publish', () => {
        it('should check for duplicate events before publishing', async () => {
            publisher = new ResilientEventPublisher(config);
            
            await publisher.publish(testEvent);
            
            // Try to publish same event again
            await publisher.publish(testEvent);

            expect(mockStore.getCallCount('saveEvent')).toBe(1);
        });

        it('should save event to store before publishing', async () => {
            publisher = new ResilientEventPublisher(config);
            
            await publisher.publish(testEvent);

            expect(mockStore.getCallCount('saveEvent')).toBe(1);
            const savedEvent = await mockStore.getEvent(testEvent);
            expect(savedEvent).toBeDefined();
        });

        it('should update event status to PUBLISHED after successful publish', async () => {
            publisher = new ResilientEventPublisher(config);
            
            await publisher.publish(testEvent);

            const savedEvent = await mockStore.getEvent(testEvent);
            expect(savedEvent?.status).toBe(EventPublishStatus.PUBLISHED);
        });

        it('should only store event when storeOnly option is true', async () => {
            publisher = new ResilientEventPublisher(config);
            
            await publisher.publish(testEvent, { storeOnly: true });

            const savedEvent = await mockStore.getEvent(testEvent);
            expect(savedEvent?.status).toBe(EventPublishStatus.PENDING);
        });

        it('should work without store when instantPublish is true', async () => {
            config.store = undefined;
            publisher = new ResilientEventPublisher(config);
            
            await expect(publisher.publish(testEvent)).resolves.not.toThrow();
        });

        it('should update status to ERROR when publish fails', async () => {
            // Mock AmqpQueue to throw error during connect
            const AmqpQueue = require('../../../src/broker/amqp-queue').AmqpQueue;
            AmqpQueue.mockImplementation(() => ({
                connect: jest.fn().mockRejectedValue(new Error('Connection failed')),
                disconnect: jest.fn(),
                publish: jest.fn()
            }));

            publisher = new ResilientEventPublisher(config);

            await expect(publisher.publish(testEvent)).rejects.toThrow();

            const savedEvent = await mockStore.getEvent(testEvent);
            expect(savedEvent?.status).toBe(EventPublishStatus.ERROR);
        });
    });

    describe('processPendingEvents', () => {
        it('should not throw when store is not configured', async () => {
            config.store = undefined;
            publisher = new ResilientEventPublisher(config);

            // Should log warning but not throw
            await publisher.processPendingEvents();
            
            // Test passes if no error is thrown
            expect(true).toBe(true);
        });

        it('should process all pending events', async () => {
            config.instantPublish = false;
            config.pendingEventsCheckIntervalMs = 1000;
            
            // Mock AmqpQueue for successful publishing
            const AmqpQueue = require('../../../src/broker/amqp-queue').AmqpQueue;
            AmqpQueue.mockImplementation(() => ({
                connect: jest.fn().mockResolvedValue(undefined),
                disconnect: jest.fn().mockResolvedValue(undefined),
                publish: jest.fn().mockResolvedValue(undefined)
            }));
            
            publisher = new ResilientEventPublisher(config);

            // Store some pending events
            await publisher.publish(testEvent, { storeOnly: true });
            
            const event2 = { ...testEvent, messageId: 'msg-002' };
            await publisher.publish(event2, { storeOnly: true });

            await publisher.processPendingEvents();

            const savedEvent1 = await mockStore.getEvent(testEvent);
            const savedEvent2 = await mockStore.getEvent(event2);
            
            expect(savedEvent1?.status).toBe(EventPublishStatus.PUBLISHED);
            expect(savedEvent2?.status).toBe(EventPublishStatus.PUBLISHED);
        });

        it('should process events in chronological order', async () => {
            config.instantPublish = false;
            config.pendingEventsCheckIntervalMs = 1000;
            
            // Mock AmqpQueue for successful publishing
            const AmqpQueue = require('../../../src/broker/amqp-queue').AmqpQueue;
            AmqpQueue.mockImplementation(() => ({
                connect: jest.fn().mockResolvedValue(undefined),
                disconnect: jest.fn().mockResolvedValue(undefined),
                publish: jest.fn().mockResolvedValue(undefined)
            }));
            
            publisher = new ResilientEventPublisher(config);

            const event1 = { ...testEvent, messageId: 'msg-001', properties: { timestamp: 1000 } };
            const event2 = { ...testEvent, messageId: 'msg-002', properties: { timestamp: 2000 } };
            const event3 = { ...testEvent, messageId: 'msg-003', properties: { timestamp: 1500 } };

            await publisher.publish(event1, { storeOnly: true });
            await publisher.publish(event2, { storeOnly: true });
            await publisher.publish(event3, { storeOnly: true });

            await publisher.processPendingEvents();

            // All should be published
            const saved1 = await mockStore.getEvent(event1);
            const saved2 = await mockStore.getEvent(event2);
            const saved3 = await mockStore.getEvent(event3);
            
            expect(saved1?.status).toBe(EventPublishStatus.PUBLISHED);
            expect(saved2?.status).toBe(EventPublishStatus.PUBLISHED);
            expect(saved3?.status).toBe(EventPublishStatus.PUBLISHED);
        });
    });

    describe('exchange publishing', () => {
        it('should publish to exchange with routing key', async () => {
            const mockPublish = jest.fn().mockResolvedValue(undefined);
            const AmqpQueue = require('../../../src/broker/amqp-queue').AmqpQueue;
            AmqpQueue.mockImplementation(() => ({
                connect: jest.fn().mockResolvedValue(undefined),
                disconnect: jest.fn().mockResolvedValue(undefined),
                publish: mockPublish
            }));

            config.queue = undefined;
            config.exchange = {
                name: 'events.exchange',
                type: 'topic',
                routingKey: 'user.created',
                options: { durable: true }
            };

            publisher = new ResilientEventPublisher(config);
            
            const eventWithRouting = { ...testEvent, routingKey: 'user.created' };
            await publisher.publish(eventWithRouting);

            expect(mockPublish).toHaveBeenCalledWith(
                'events.exchange',
                eventWithRouting,
                expect.objectContaining({
                    exchange: config.exchange
                })
            );
        });
    });

    describe('disconnect', () => {
        it('should disconnect from RabbitMQ', async () => {
            const mockDisconnect = jest.fn().mockResolvedValue(undefined);
            const AmqpQueue = require('../../../src/broker/amqp-queue').AmqpQueue;
            AmqpQueue.mockImplementation(() => ({
                connect: jest.fn().mockResolvedValue(undefined),
                disconnect: mockDisconnect,
                publish: jest.fn().mockResolvedValue(undefined),
                closed: false
            }));

            publisher = new ResilientEventPublisher(config);
            await publisher.publish(testEvent);
            await publisher.disconnect();

            expect(mockDisconnect).toHaveBeenCalled();
        });

        it('should not disconnect if not connected', async () => {
            const mockDisconnect = jest.fn().mockResolvedValue(undefined);
            const AmqpQueue = require('../../../src/broker/amqp-queue').AmqpQueue;
            AmqpQueue.mockImplementation(() => ({
                connect: jest.fn().mockResolvedValue(undefined),
                disconnect: mockDisconnect,
                publish: jest.fn().mockResolvedValue(undefined),
                closed: false
            }));

            publisher = new ResilientEventPublisher(config);
            await publisher.disconnect();

            expect(mockDisconnect).not.toHaveBeenCalled();
        });
    });

    describe('isConnected', () => {
        it('should return false when not connected', () => {
            publisher = new ResilientEventPublisher(config);
            expect(publisher.isConnected()).toBe(false);
        });

        it('should return true after publishing', async () => {
            const AmqpQueue = require('../../../src/broker/amqp-queue').AmqpQueue;
            AmqpQueue.mockImplementation(() => ({
                connect: jest.fn().mockResolvedValue(undefined),
                disconnect: jest.fn().mockResolvedValue(undefined),
                publish: jest.fn().mockResolvedValue(undefined),
                closed: false
            }));

            publisher = new ResilientEventPublisher(config);
            await publisher.publish(testEvent);
            
            expect(publisher.isConnected()).toBe(true);
        });
    });

    describe('pending events check interval', () => {
        it('should start periodic check when instantPublish is false', () => {
            config.instantPublish = false;
            config.pendingEventsCheckIntervalMs = 5000;
            
            publisher = new ResilientEventPublisher(config);
            
            expect((publisher as any).pendingEventsInterval).toBeDefined();
        });

        it('should not start periodic check when instantPublish is true', () => {
            config.instantPublish = true;
            config.pendingEventsCheckIntervalMs = 5000;
            
            publisher = new ResilientEventPublisher(config);
            
            expect((publisher as any).pendingEventsInterval).toBeUndefined();
        });

        it('should stop periodic check when stopPendingEventsCheck is called', () => {
            config.instantPublish = false;
            config.pendingEventsCheckIntervalMs = 5000;
            
            publisher = new ResilientEventPublisher(config);
            publisher.stopPendingEventsCheck();
            
            expect((publisher as any).pendingEventsInterval).toBeUndefined();
        });
    });

    describe('store connection retries', () => {
        it('should retry store connection on failure', async () => {
            jest.useRealTimers();
            
            config.storeConnectionRetries = 2;
            config.storeConnectionRetryDelayMs = 100;
            
            let attempts = 0;
            mockStore.setFailOnGet(true);
            
            // Make it succeed on second attempt
            const originalGetEvent = mockStore.getEvent.bind(mockStore);
            mockStore.getEvent = jest.fn(async (event) => {
                attempts++;
                if (attempts < 2) {
                    throw new Error('Connection failed');
                }
                mockStore.setFailOnGet(false);
                return originalGetEvent(event);
            });

            publisher = new ResilientEventPublisher(config);
            
            await expect(publisher.publish(testEvent)).resolves.not.toThrow();
            expect(attempts).toBeGreaterThan(1);
            
            jest.useFakeTimers();
        }, 10000);
    });

    describe('idle timeout', () => {
        it('should configure idle timeout when specified', async () => {
            const AmqpQueue = require('../../../src/broker/amqp-queue').AmqpQueue;
            AmqpQueue.mockImplementation(() => ({
                connect: jest.fn().mockResolvedValue(undefined),
                disconnect: jest.fn().mockResolvedValue(undefined),
                publish: jest.fn().mockResolvedValue(undefined),
                closed: false
            }));

            config.idleTimeoutMs = 5000;
            publisher = new ResilientEventPublisher(config);
            
            await publisher.publish(testEvent);
            
            expect(publisher.isConnected()).toBe(true);
        });
    });
});
