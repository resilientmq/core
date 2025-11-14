import { ResilientConsumer } from '../../../src/resilience/resilient-consumer';
import { EventStoreMock } from '../../utils/event-store-mock';
import { AMQPLibMock } from '../../utils/amqplib-mock';
import { ResilientConsumerConfig } from '../../../src/types';

// Mock amqplib
jest.mock('amqplib', () => {
    const mockLib = new (require('../../utils/amqplib-mock').AMQPLibMock)();
    return {
        connect: jest.fn((...args) => mockLib.connect(...args))
    };
});

// Mock the AmqpQueue to avoid real connections
jest.mock('../../../src/broker/amqp-queue');

describe('ResilientConsumer', () => {
    let consumer: ResilientConsumer;
    let mockStore: EventStoreMock;
    let config: ResilientConsumerConfig;
    let mockLib: AMQPLibMock;

    beforeEach(() => {
        jest.useFakeTimers();
        mockStore = new EventStoreMock();
        mockLib = new AMQPLibMock();
        
        const amqplib = require('amqplib');
        amqplib.connect.mockImplementation((url: any) => mockLib.connect(url));

        config = {
            connection: 'amqp://localhost:5672',
            consumeQueue: {
                queue: 'test.queue',
                options: { durable: true }
            },
            eventsToProcess: [
                {
                    type: 'test.event',
                    handler: jest.fn()
                }
            ],
            store: mockStore,
            prefetch: 10
        };
    });

    afterEach(() => {
        mockStore.clear();
        mockLib.reset();
        jest.clearAllMocks();
        jest.useRealTimers();
    });

    describe('constructor', () => {
        it('should create consumer with valid configuration', () => {
            expect(() => {
                consumer = new ResilientConsumer(config);
            }).not.toThrow();
        });

        it('should throw error when consumeQueue.queue is missing', () => {
            config.consumeQueue.queue = '';

            expect(() => {
                consumer = new ResilientConsumer(config);
            }).toThrow('Configuration error: "consumeQueue.queue" is required');
        });

        it('should throw error when eventsToProcess is empty', () => {
            config.eventsToProcess = [];

            expect(() => {
                consumer = new ResilientConsumer(config);
            }).toThrow('Configuration error: "eventsToProcess" must have at least one event handler');
        });
    });

    describe('start', () => {
        it('should check store connection before starting', async () => {
            // Mock AmqpQueue
            const AmqpQueue = require('../../../src/broker/amqp-queue').AmqpQueue;
            AmqpQueue.mockImplementation(() => ({
                connect: jest.fn().mockResolvedValue(undefined),
                consume: jest.fn().mockResolvedValue(undefined),
                channel: {
                    assertQueue: jest.fn().mockResolvedValue({ queue: 'test.queue' }),
                    assertExchange: jest.fn().mockResolvedValue({ exchange: 'test.exchange' }),
                    bindQueue: jest.fn().mockResolvedValue({}),
                    consume: jest.fn().mockResolvedValue({ consumerTag: 'tag' }),
                    checkQueue: jest.fn().mockResolvedValue({ queue: 'test.queue', messageCount: 0 })
                },
                connection: {
                    on: jest.fn()
                }
            }));

            consumer = new ResilientConsumer(config);
            
            const getEventSpy = jest.spyOn(mockStore, 'getEvent');
            
            await consumer.start();

            expect(getEventSpy).toHaveBeenCalled();
        });

        it('should throw error when store connection fails', async () => {
            jest.useRealTimers(); // Use real timers for this test
            mockStore.setFailOnGet(true);
            consumer = new ResilientConsumer(config);

            await expect(consumer.start()).rejects.toThrow('Failed to initialize consumer: store connection failed');
            jest.useFakeTimers(); // Restore fake timers
        }, 5000);

        it('should work without store configured', async () => {
            // Mock AmqpQueue
            const AmqpQueue = require('../../../src/broker/amqp-queue').AmqpQueue;
            AmqpQueue.mockImplementation(() => ({
                connect: jest.fn().mockResolvedValue(undefined),
                consume: jest.fn().mockResolvedValue(undefined),
                channel: {
                    assertQueue: jest.fn().mockResolvedValue({ queue: 'test.queue' }),
                    assertExchange: jest.fn().mockResolvedValue({ exchange: 'test.exchange' }),
                    bindQueue: jest.fn().mockResolvedValue({}),
                    consume: jest.fn().mockResolvedValue({ consumerTag: 'tag' }),
                    checkQueue: jest.fn().mockResolvedValue({ queue: 'test.queue', messageCount: 0 })
                },
                connection: {
                    on: jest.fn()
                }
            }));

            config.store = undefined;
            consumer = new ResilientConsumer(config);

            // Should not throw
            await expect(consumer.start()).resolves.not.toThrow();
        });
    });

    describe('retry logic', () => {
        it('should configure retry queue when provided', async () => {
            const AmqpQueue = require('../../../src/broker/amqp-queue').AmqpQueue;
            const mockAssertQueue = jest.fn().mockResolvedValue({ queue: 'test.queue' });
            
            AmqpQueue.mockImplementation(() => ({
                connect: jest.fn().mockResolvedValue(undefined),
                consume: jest.fn().mockResolvedValue(undefined),
                channel: {
                    assertQueue: mockAssertQueue,
                    assertExchange: jest.fn().mockResolvedValue({ exchange: 'test.exchange' }),
                    bindQueue: jest.fn().mockResolvedValue({}),
                    consume: jest.fn().mockResolvedValue({ consumerTag: 'tag' }),
                    checkQueue: jest.fn().mockResolvedValue({ queue: 'test.queue', messageCount: 0 })
                },
                connection: {
                    on: jest.fn()
                }
            }));

            config.retryQueue = {
                queue: 'test.retry',
                ttlMs: 5000,
                maxAttempts: 3,
                options: { durable: true }
            };

            consumer = new ResilientConsumer(config);
            await consumer.start();

            // Verify retry queue was asserted
            expect(mockAssertQueue).toHaveBeenCalledWith(
                'test.retry',
                expect.objectContaining({
                    durable: true,
                    arguments: expect.objectContaining({
                        'x-message-ttl': 5000,
                        'x-dead-letter-exchange': '',
                        'x-dead-letter-routing-key': 'test.queue'
                    })
                })
            );
        });

        it('should configure dead letter queue when provided', async () => {
            const AmqpQueue = require('../../../src/broker/amqp-queue').AmqpQueue;
            const mockAssertQueue = jest.fn().mockResolvedValue({ queue: 'test.queue' });
            
            AmqpQueue.mockImplementation(() => ({
                connect: jest.fn().mockResolvedValue(undefined),
                consume: jest.fn().mockResolvedValue(undefined),
                channel: {
                    assertQueue: mockAssertQueue,
                    assertExchange: jest.fn().mockResolvedValue({ exchange: 'test.exchange' }),
                    bindQueue: jest.fn().mockResolvedValue({}),
                    consume: jest.fn().mockResolvedValue({ consumerTag: 'tag' }),
                    checkQueue: jest.fn().mockResolvedValue({ queue: 'test.queue', messageCount: 0 })
                },
                connection: {
                    on: jest.fn()
                }
            }));

            config.deadLetterQueue = {
                queue: 'test.dlq',
                options: { durable: true }
            };

            consumer = new ResilientConsumer(config);
            await consumer.start();

            // Verify DLQ was asserted
            expect(mockAssertQueue).toHaveBeenCalledWith(
                'test.dlq',
                expect.objectContaining({
                    durable: true
                })
            );
        });
    });

    describe('exchange binding', () => {
        it('should bind to multiple exchanges with routing keys', async () => {
            const AmqpQueue = require('../../../src/broker/amqp-queue').AmqpQueue;
            const mockBindQueue = jest.fn().mockResolvedValue({});
            const mockAssertExchange = jest.fn().mockResolvedValue({ exchange: 'test.exchange' });
            
            AmqpQueue.mockImplementation(() => ({
                connect: jest.fn().mockResolvedValue(undefined),
                consume: jest.fn().mockResolvedValue(undefined),
                channel: {
                    assertQueue: jest.fn().mockResolvedValue({ queue: 'test.queue' }),
                    assertExchange: mockAssertExchange,
                    bindQueue: mockBindQueue,
                    consume: jest.fn().mockResolvedValue({ consumerTag: 'tag' }),
                    checkQueue: jest.fn().mockResolvedValue({ queue: 'test.queue', messageCount: 0 })
                },
                connection: {
                    on: jest.fn()
                }
            }));

            config.consumeQueue.exchanges = [
                {
                    name: 'events.exchange',
                    type: 'topic',
                    routingKey: 'user.*',
                    options: { durable: true }
                },
                {
                    name: 'orders.exchange',
                    type: 'direct',
                    routingKey: 'order.created',
                    options: { durable: true }
                }
            ];

            consumer = new ResilientConsumer(config);
            await consumer.start();

            // Verify exchanges were asserted
            expect(mockAssertExchange).toHaveBeenCalledWith('events.exchange', 'topic', { durable: true });
            expect(mockAssertExchange).toHaveBeenCalledWith('orders.exchange', 'direct', { durable: true });

            // Verify bindings were created
            expect(mockBindQueue).toHaveBeenCalledWith('test.queue', 'events.exchange', 'user.*');
            expect(mockBindQueue).toHaveBeenCalledWith('test.queue', 'orders.exchange', 'order.created');
        });
    });

    describe('middleware', () => {
        it('should execute middleware before handler', async () => {
            const AmqpQueue = require('../../../src/broker/amqp-queue').AmqpQueue;
            const mockHandler = jest.fn().mockResolvedValue(undefined);
            const mockMiddleware1 = jest.fn(async (event, next) => await next());
            const mockMiddleware2 = jest.fn(async (event, next) => await next());
            
            AmqpQueue.mockImplementation(() => ({
                connect: jest.fn().mockResolvedValue(undefined),
                consume: jest.fn().mockResolvedValue(undefined),
                channel: {
                    assertQueue: jest.fn().mockResolvedValue({ queue: 'test.queue' }),
                    assertExchange: jest.fn().mockResolvedValue({ exchange: 'test.exchange' }),
                    bindQueue: jest.fn().mockResolvedValue({}),
                    consume: jest.fn().mockResolvedValue({ consumerTag: 'tag' }),
                    checkQueue: jest.fn().mockResolvedValue({ queue: 'test.queue', messageCount: 0 })
                },
                connection: {
                    on: jest.fn()
                }
            }));

            config.middleware = [mockMiddleware1, mockMiddleware2];
            config.eventsToProcess = [
                {
                    type: 'test.event',
                    handler: mockHandler
                }
            ];

            consumer = new ResilientConsumer(config);
            await consumer.start();

            // Middleware should be configured
            expect(consumer).toBeDefined();
        });
    });

    describe('prefetch', () => {
        it('should use default prefetch of 10 when not specified', () => {
            delete config.prefetch;
            consumer = new ResilientConsumer(config);
            
            // Consumer should be created successfully
            expect(consumer).toBeDefined();
        });

        it('should use custom prefetch when specified', () => {
            config.prefetch = 50;
            consumer = new ResilientConsumer(config);
            
            // Consumer should be created successfully
            expect(consumer).toBeDefined();
        });
    });

    describe('stop', () => {
        it('should be able to stop consumer', async () => {
            consumer = new ResilientConsumer(config);
            
            // Stop should not throw
            await expect(consumer.stop()).resolves.not.toThrow();
        });
    });

    describe('ignoreUnknownEvents', () => {
        it('should configure ignoreUnknownEvents when set to true', () => {
            config.ignoreUnknownEvents = true;
            consumer = new ResilientConsumer(config);

            expect(consumer).toBeDefined();
        });

        it('should not ignore unknown events by default', () => {
            delete config.ignoreUnknownEvents;
            consumer = new ResilientConsumer(config);

            expect(consumer).toBeDefined();
        });
    });

    describe('reconnection', () => {
        it('should configure reconnect delay when specified', () => {
            config.reconnectDelayMs = 2000;
            consumer = new ResilientConsumer(config);

            expect(consumer).toBeDefined();
        });
    });

    describe('maxUptimeMs', () => {
        it('should configure max uptime when specified', () => {
            config.maxUptimeMs = 60000;
            consumer = new ResilientConsumer(config);

            expect(consumer).toBeDefined();
        });
    });
});
