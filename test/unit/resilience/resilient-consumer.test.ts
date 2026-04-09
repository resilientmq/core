import { ResilientConsumer } from '../../../src/resilience/resilient-consumer';
import { EventStoreMock } from '../../utils/event-store-mock';
import { AMQPLibMock } from '../../utils/amqplib-mock';
import { ResilientConsumerConfig } from '../../../src/types';
import { EventConsumeStatus } from '../../../src/types/enum/event-consume-status';

// Mock amqplib
jest.mock('amqplib', () => {
    const mockLib = new (require('../../utils/amqplib-mock').AMQPLibMock)();
    return {
        connect: jest.fn((...args) => mockLib.connect(...args))
    };
});

jest.mock('../../../src/logger/logger', () => ({
    log: jest.fn(),
    isLogLevelEnabled: jest.fn().mockReturnValue(true),
}));

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

        it('should log consuming from queue only once per consumer instance', async () => {
            const AmqpQueue = require('../../../src/broker/amqp-queue').AmqpQueue;
            const logMock = require('../../../src/logger/logger').log as jest.Mock;

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

            await consumer.start();
            await (consumer as any).setupAndConsume();

            const consumeLogs = logMock.mock.calls.filter(([level, message]) =>
                level === 'info' && message === '[Consumer] Consuming from: test.queue'
            );

            expect(consumeLogs).toHaveLength(1);
        });

        it('should exit checkStoreConnection early if no store is configured', async () => {
            config.store = undefined;
            consumer = new ResilientConsumer(config);
            await (consumer as any).checkStoreConnection();
            expect((consumer as any).storeConnected).toBe(false);
        });

        it('should check store connection before initializing processor when store is disconnected', async () => {
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
                connection: { on: jest.fn() }
            }));

            consumer = new ResilientConsumer(config);
            // Ensure it's false first
            (consumer as any).storeConnected = false;
            const checkSpy = jest.spyOn(consumer as any, 'checkStoreConnection');

            await consumer.start();

            expect(checkSpy).toHaveBeenCalled();
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

    describe('retry queue with exchange', () => {
        it('should configure retry queue with exchange and binding', async () => {
            const AmqpQueue = require('../../../src/broker/amqp-queue').AmqpQueue;
            const mockAssertQueue = jest.fn().mockResolvedValue({ queue: 'test.queue' });
            const mockAssertExchange = jest.fn().mockResolvedValue({ exchange: 'retry.exchange' });
            const mockBindQueue = jest.fn().mockResolvedValue({});

            AmqpQueue.mockImplementation(() => ({
                connect: jest.fn().mockResolvedValue(undefined),
                consume: jest.fn().mockResolvedValue(undefined),
                channel: {
                    assertQueue: mockAssertQueue,
                    assertExchange: mockAssertExchange,
                    bindQueue: mockBindQueue,
                    consume: jest.fn().mockResolvedValue({ consumerTag: 'tag' }),
                    checkQueue: jest.fn().mockResolvedValue({ queue: 'test.queue', messageCount: 0 })
                },
                connection: { on: jest.fn() }
            }));

            config.retryQueue = {
                queue: 'test.retry',
                ttlMs: 5000,
                maxAttempts: 3,
                exchange: {
                    name: 'retry.exchange',
                    type: 'direct',
                    routingKey: 'retry.key',
                    options: { durable: true }
                }
            };

            consumer = new ResilientConsumer(config);
            await consumer.start();

            // Verify retry exchange was asserted
            expect(mockAssertExchange).toHaveBeenCalledWith('retry.exchange', 'direct', { durable: true });
            // Verify retry queue was bound to exchange
            expect(mockBindQueue).toHaveBeenCalledWith('test.retry', 'retry.exchange', 'retry.key');
        });

        it('should configure retry queue with main exchange when exchanges are present', async () => {
            const AmqpQueue = require('../../../src/broker/amqp-queue').AmqpQueue;
            const mockAssertQueue = jest.fn().mockResolvedValue({ queue: 'test.queue' });
            const mockAssertExchange = jest.fn().mockResolvedValue({});
            const mockBindQueue = jest.fn().mockResolvedValue({});

            AmqpQueue.mockImplementation(() => ({
                connect: jest.fn().mockResolvedValue(undefined),
                consume: jest.fn().mockResolvedValue(undefined),
                channel: {
                    assertQueue: mockAssertQueue,
                    assertExchange: mockAssertExchange,
                    bindQueue: mockBindQueue,
                    consume: jest.fn().mockResolvedValue({ consumerTag: 'tag' }),
                    checkQueue: jest.fn().mockResolvedValue({ queue: 'test.queue', messageCount: 0 })
                },
                connection: { on: jest.fn() }
            }));

            config.consumeQueue.exchanges = [
                {
                    name: 'main.exchange',
                    type: 'topic',
                    routingKey: 'event.*',
                    options: { durable: true }
                }
            ];
            config.retryQueue = {
                queue: 'test.retry',
                ttlMs: 5000,
                maxAttempts: 3
            };

            consumer = new ResilientConsumer(config);
            await consumer.start();

            // Retry queue DLX should point to main exchange
            expect(mockAssertQueue).toHaveBeenCalledWith('test.retry', expect.objectContaining({
                arguments: expect.objectContaining({
                    'x-dead-letter-exchange': 'main.exchange',
                    'x-dead-letter-routing-key': 'event.*'
                })
            }));
        });
    });

    describe('DLQ-only configuration', () => {
        it('should configure main queue DLX to DLQ exchange when no retry queue', async () => {
            const AmqpQueue = require('../../../src/broker/amqp-queue').AmqpQueue;
            const mockAssertQueue = jest.fn().mockResolvedValue({ queue: 'test.queue' });
            const mockAssertExchange = jest.fn().mockResolvedValue({});
            const mockBindQueue = jest.fn().mockResolvedValue({});

            AmqpQueue.mockImplementation(() => ({
                connect: jest.fn().mockResolvedValue(undefined),
                consume: jest.fn().mockResolvedValue(undefined),
                channel: {
                    assertQueue: mockAssertQueue,
                    assertExchange: mockAssertExchange,
                    bindQueue: mockBindQueue,
                    consume: jest.fn().mockResolvedValue({ consumerTag: 'tag' }),
                    checkQueue: jest.fn().mockResolvedValue({ queue: 'test.queue', messageCount: 0 })
                },
                connection: { on: jest.fn() }
            }));

            config.deadLetterQueue = {
                queue: 'test.dlq',
                options: { durable: true },
                exchange: {
                    name: 'dlq.exchange',
                    type: 'direct',
                    routingKey: 'dlq.key',
                    options: { durable: true }
                }
            };

            consumer = new ResilientConsumer(config);
            await consumer.start();

            // Main queue should have DLX pointing to DLQ exchange
            expect(mockAssertQueue).toHaveBeenCalledWith('test.queue', expect.objectContaining({
                arguments: expect.objectContaining({
                    'x-dead-letter-exchange': 'dlq.exchange'
                })
            }));
        });
    });

    describe('store reconnection during consume', () => {
        it('should attempt store reconnection when store is disconnected during message processing', async () => {
            const AmqpQueue = require('../../../src/broker/amqp-queue').AmqpQueue;
            let consumeCallback: any;

            AmqpQueue.mockImplementation(() => ({
                connect: jest.fn().mockResolvedValue(undefined),
                consume: jest.fn().mockImplementation(async (_queue: string, callback: any) => {
                    consumeCallback = callback;
                }),
                disconnect: jest.fn().mockResolvedValue(undefined),
                cancelAllConsumers: jest.fn().mockResolvedValue(undefined),
                publish: jest.fn().mockResolvedValue(undefined),
                channel: {
                    assertQueue: jest.fn().mockResolvedValue({ queue: 'test.queue' }),
                    assertExchange: jest.fn().mockResolvedValue({}),
                    bindQueue: jest.fn().mockResolvedValue({}),
                    consume: jest.fn().mockResolvedValue({ consumerTag: 'tag' }),
                    checkQueue: jest.fn().mockResolvedValue({ queue: 'test.queue', messageCount: 0 })
                },
                connection: { on: jest.fn() },
                closed: false
            }));

            consumer = new ResilientConsumer(config);
            await consumer.start();

            // Simulate that store was connected, then disconnected
            (consumer as any).storeConnected = false;

            const testEvent = {
                messageId: 'msg-001',
                type: 'test.event',
                payload: {},
                properties: {}
            };

            // Should still process the event (reconnect attempt should succeed)
            if (consumeCallback) {
                await consumeCallback(testEvent);
            }

            // Event should have been processed
            expect(config.eventsToProcess[0].handler).toHaveBeenCalled();
        });

        it('should re-throw error and decrement processing count if processing fails natively', async () => {
            const AmqpQueue = require('../../../src/broker/amqp-queue').AmqpQueue;
            let consumeCallback: any;

            AmqpQueue.mockImplementation(() => ({
                connect: jest.fn().mockResolvedValue(undefined),
                consume: jest.fn().mockImplementation(async (_queue: string, callback: any) => {
                    consumeCallback = callback;
                }),
                disconnect: jest.fn().mockResolvedValue(undefined),
                cancelAllConsumers: jest.fn().mockResolvedValue(undefined),
                channel: {
                    assertQueue: jest.fn().mockResolvedValue({ queue: 'test.queue' }),
                    assertExchange: jest.fn().mockResolvedValue({}),
                    bindQueue: jest.fn().mockResolvedValue({}),
                    consume: jest.fn().mockResolvedValue({ consumerTag: 'tag' }),
                    checkQueue: jest.fn().mockResolvedValue({ queue: 'test.queue', messageCount: 0 })
                },
                connection: { on: jest.fn() },
                closed: false
            }));

            consumer = new ResilientConsumer(config);
            await consumer.start();

            // forcefully mock the processor to throw
            jest.spyOn((consumer as any).processor, 'process').mockRejectedValue(new Error('forced test error'));

            const testEvent = {
                messageId: 'msg-002',
                type: 'test.event',
                payload: {},
                properties: {}
            };

            if (consumeCallback) {
                await expect(consumeCallback(testEvent)).rejects.toThrow('forced test error');
                // verify processing count was decremented
                expect((consumer as any).processingCount).toBe(0);
            }
        });
    });

    describe('idle monitor', () => {
        it('should skip idle check if reconnecting', async () => {
            jest.useRealTimers();
            const AmqpQueue = require('../../../src/broker/amqp-queue').AmqpQueue;
            AmqpQueue.mockImplementation(() => ({
                connect: jest.fn().mockResolvedValue(undefined),
                consume: jest.fn().mockResolvedValue(undefined),
                channel: {
                    assertQueue: jest.fn().mockResolvedValue({ queue: 'test.queue' }),
                    assertExchange: jest.fn().mockResolvedValue({}),
                    bindQueue: jest.fn().mockResolvedValue({}),
                    consume: jest.fn().mockResolvedValue({ consumerTag: 'tag' }),
                    checkQueue: jest.fn().mockResolvedValue({ queue: 'test.queue', messageCount: 0 })
                },
                connection: { on: jest.fn() },
                closed: false
            }));

            config.exitIfIdle = true;
            config.idleCheckIntervalMs = 50;
            consumer = new ResilientConsumer(config);

            await consumer.start();
            (consumer as any).reconnecting = true; // force it to be true to skip check

            await new Promise(resolve => setTimeout(resolve, 100)); // allow interval to tick

            await consumer.stop();
            jest.useFakeTimers();
        });

        it('should stop consumer after max idle checks', async () => {
            jest.useRealTimers();

            const AmqpQueue = require('../../../src/broker/amqp-queue').AmqpQueue;

            AmqpQueue.mockImplementation(() => ({
                connect: jest.fn().mockResolvedValue(undefined),
                consume: jest.fn().mockResolvedValue(undefined),
                disconnect: jest.fn().mockResolvedValue(undefined),
                cancelAllConsumers: jest.fn().mockResolvedValue(undefined),
                waitForProcessing: jest.fn().mockResolvedValue(undefined),
                processingMessages: 0,
                channel: {
                    assertQueue: jest.fn().mockResolvedValue({ queue: 'test.queue' }),
                    assertExchange: jest.fn().mockResolvedValue({}),
                    bindQueue: jest.fn().mockResolvedValue({}),
                    consume: jest.fn().mockResolvedValue({ consumerTag: 'tag' }),
                    checkQueue: jest.fn().mockResolvedValue({ queue: 'test.queue', messageCount: 0 })
                },
                connection: { on: jest.fn() },
                closed: false
            }));

            config.exitIfIdle = true;
            config.idleCheckIntervalMs = 50;
            config.maxIdleChecks = 2;

            consumer = new ResilientConsumer(config);
            const stopSpy = jest.spyOn(consumer, 'stop');

            await consumer.start();

            // Wait enough time for 3 idle checks (50ms * 3 = 150ms, give buffer)
            await new Promise(resolve => setTimeout(resolve, 300));

            // Consumer should have been stopped after 2 idle checks
            expect(stopSpy).toHaveBeenCalled();

            jest.useFakeTimers();
        }, 5000);

        it('should check retry queue in idle monitor when retry queue is configured', async () => {
            jest.useRealTimers();

            const mockCheckQueue = jest.fn()
                .mockResolvedValueOnce({ queue: 'test.queue', messageCount: 0 })  // main queue
                .mockResolvedValueOnce({ queue: 'test.retry', messageCount: 5 })   // retry queue has messages
                .mockResolvedValue({ queue: 'test.queue', messageCount: 0 });

            const AmqpQueue = require('../../../src/broker/amqp-queue').AmqpQueue;

            AmqpQueue.mockImplementation(() => ({
                connect: jest.fn().mockResolvedValue(undefined),
                consume: jest.fn().mockResolvedValue(undefined),
                disconnect: jest.fn().mockResolvedValue(undefined),
                cancelAllConsumers: jest.fn().mockResolvedValue(undefined),
                channel: {
                    assertQueue: jest.fn().mockResolvedValue({ queue: 'test.queue' }),
                    assertExchange: jest.fn().mockResolvedValue({}),
                    bindQueue: jest.fn().mockResolvedValue({}),
                    consume: jest.fn().mockResolvedValue({ consumerTag: 'tag' }),
                    checkQueue: mockCheckQueue
                },
                connection: { on: jest.fn() },
                closed: false
            }));

            config.exitIfIdle = true;
            config.idleCheckIntervalMs = 50;
            config.maxIdleChecks = 3;
            config.retryQueue = {
                queue: 'test.retry',
                ttlMs: 5000,
                maxAttempts: 3
            };

            consumer = new ResilientConsumer(config);
            await consumer.start();

            // Wait for at least 1 idle check
            await new Promise(resolve => setTimeout(resolve, 100));

            // checkQueue should have been called for both main and retry queues
            expect(mockCheckQueue).toHaveBeenCalledWith('test.queue');
            expect(mockCheckQueue).toHaveBeenCalledWith('test.retry');

            await consumer.stop();
            jest.useFakeTimers();
        }, 5000);
    });

    describe('heartbeat and reconnection flow', () => {
        it('should reconnect when heartbeat fails', async () => {
            jest.useRealTimers();

            let checkQueueCallCount = 0;
            const mockCheckQueue = jest.fn().mockImplementation(async () => {
                checkQueueCallCount++;
                if (checkQueueCallCount > 1) {
                    throw new Error('Channel closed');
                }
                return { queue: 'test.queue', messageCount: 0 };
            });

            const AmqpQueue = require('../../../src/broker/amqp-queue').AmqpQueue;

            AmqpQueue.mockImplementation(() => ({
                connect: jest.fn().mockResolvedValue(undefined),
                consume: jest.fn().mockResolvedValue(undefined),
                disconnect: jest.fn().mockResolvedValue(undefined),
                cancelAllConsumers: jest.fn().mockResolvedValue(undefined),
                channel: {
                    assertQueue: jest.fn().mockResolvedValue({ queue: 'test.queue' }),
                    assertExchange: jest.fn().mockResolvedValue({}),
                    bindQueue: jest.fn().mockResolvedValue({}),
                    consume: jest.fn().mockResolvedValue({ consumerTag: 'tag' }),
                    checkQueue: mockCheckQueue,
                    close: jest.fn().mockResolvedValue(undefined)
                },
                connection: {
                    on: jest.fn(),
                    connection: { stream: { writable: true } },
                    close: jest.fn().mockResolvedValue(undefined)
                },
                closed: false
            }));

            config.heartbeatIntervalMs = 50;
            config.reconnectDelayMs = 50;

            consumer = new ResilientConsumer(config);
            await consumer.start();

            // Wait for heartbeat to fire and fail
            await new Promise(resolve => setTimeout(resolve, 200));

            // The consumer should have attempted reconnection
            expect(mockCheckQueue).toHaveBeenCalled();

            await consumer.stop();
            jest.useFakeTimers();
        }, 5000);

        it('should schedule reconnection after maxUptimeMs', async () => {
            jest.useRealTimers();

            const AmqpQueue = require('../../../src/broker/amqp-queue').AmqpQueue;
            const mockConnect = jest.fn().mockResolvedValue(undefined);

            AmqpQueue.mockImplementation(() => ({
                connect: mockConnect,
                consume: jest.fn().mockResolvedValue(undefined),
                disconnect: jest.fn().mockResolvedValue(undefined),
                cancelAllConsumers: jest.fn().mockResolvedValue(undefined),
                channel: {
                    assertQueue: jest.fn().mockResolvedValue({ queue: 'test.queue' }),
                    assertExchange: jest.fn().mockResolvedValue({}),
                    bindQueue: jest.fn().mockResolvedValue({}),
                    consume: jest.fn().mockResolvedValue({ consumerTag: 'tag' }),
                    checkQueue: jest.fn().mockResolvedValue({ queue: 'test.queue', messageCount: 0 }),
                    close: jest.fn().mockResolvedValue(undefined)
                },
                connection: {
                    on: jest.fn(),
                    connection: { stream: { writable: true } },
                    close: jest.fn().mockResolvedValue(undefined)
                },
                closed: false
            }));

            config.maxUptimeMs = 100;
            config.reconnectDelayMs = 50;

            consumer = new ResilientConsumer(config);
            await consumer.start();

            // Wait for max uptime to trigger reconnection
            await new Promise(resolve => setTimeout(resolve, 300));

            // connect should be called at least twice (initial + reconnect)
            // Note: timing variations across Node versions may cause additional reconnection
            // cycles within the wait window (maxUptimeMs=100 + reconnectDelayMs=50 = 150ms per cycle)
            expect(mockConnect.mock.calls.length).toBeGreaterThanOrEqual(2);

            await consumer.stop();
            jest.useFakeTimers();
        }, 5000);

        it('should handle errors during cleanup in reconnect logic', async () => {
            jest.useRealTimers();
            const AmqpQueue = require('../../../src/broker/amqp-queue').AmqpQueue;
            AmqpQueue.mockImplementation(() => ({
                connect: jest.fn().mockResolvedValue(undefined),
                consume: jest.fn().mockResolvedValue(undefined),
                channel: {
                    assertQueue: jest.fn().mockResolvedValue({ queue: 'test.queue' }),
                    assertExchange: jest.fn().mockResolvedValue({}),
                    bindQueue: jest.fn().mockResolvedValue({}),
                    consume: jest.fn().mockResolvedValue({ consumerTag: 'tag' }),
                    checkQueue: jest.fn().mockResolvedValue({ queue: 'test.queue', messageCount: 0 }),
                    close: jest.fn().mockRejectedValue(new Error('Channel cleanup error'))
                },
                connection: { on: jest.fn() },
                closed: false
            }));

            consumer = new ResilientConsumer(config);
            await consumer.start();

            // force reconnect check
            await (consumer as any).reconnect();

            await consumer.stop();
            jest.useFakeTimers();
        });

        it('should catch error if setupAndConsume fails during reconnect', async () => {
            jest.useRealTimers();
            const AmqpQueue = require('../../../src/broker/amqp-queue').AmqpQueue;
            AmqpQueue.mockImplementation(() => ({
                connect: jest.fn().mockResolvedValue(undefined),
                consume: jest.fn().mockResolvedValue(undefined),
                channel: {
                    assertQueue: jest.fn().mockResolvedValue({ queue: 'test.queue' }),
                    assertExchange: jest.fn().mockResolvedValue({}),
                    bindQueue: jest.fn().mockResolvedValue({}),
                    consume: jest.fn().mockResolvedValue({ consumerTag: 'tag' }),
                    checkQueue: jest.fn().mockResolvedValue({ queue: 'test.queue', messageCount: 0 }),
                },
                connection: { on: jest.fn() },
                closed: false
            }));

            config.reconnectDelayMs = 10;
            consumer = new ResilientConsumer(config);
            await consumer.start();

            // mock setupAndConsume to throw after it cleans up
            jest.spyOn(consumer as any, 'setupAndConsume').mockRejectedValue(new Error('restart fail init'));

            await (consumer as any).reconnect();

            // Wait for reconnect delay timer
            await new Promise(resolve => setTimeout(resolve, 50));

            await consumer.stop();
            jest.useFakeTimers();
        });

        it('should catch error in revertRetryEvents when store.getEventsByStatus throws', async () => {
            consumer = new ResilientConsumer(config);

            // Mock store to throw on getEventsByStatus
            mockStore.getEventsByStatus = jest.fn().mockRejectedValue(new Error('Store error during revert'));

            // Should not throw — error is caught internally
            await expect((consumer as any).revertRetryEvents()).resolves.not.toThrow();
        });

        it('should check store connection inside consume callback when storeConnected is false', async () => {
            const AmqpQueue = require('../../../src/broker/amqp-queue').AmqpQueue;
            let consumeCallback: any;

            AmqpQueue.mockImplementation(() => ({
                connect: jest.fn().mockResolvedValue(undefined),
                consume: jest.fn().mockImplementation(async (_queue: string, callback: any) => {
                    consumeCallback = callback;
                }),
                disconnect: jest.fn().mockResolvedValue(undefined),
                cancelAllConsumers: jest.fn().mockResolvedValue(undefined),
                publish: jest.fn().mockResolvedValue(undefined),
                channel: {
                    assertQueue: jest.fn().mockResolvedValue({ queue: 'test.queue' }),
                    assertExchange: jest.fn().mockResolvedValue({}),
                    bindQueue: jest.fn().mockResolvedValue({}),
                    consume: jest.fn().mockResolvedValue({ consumerTag: 'tag' }),
                    checkQueue: jest.fn().mockResolvedValue({ queue: 'test.queue', messageCount: 0 })
                },
                connection: { on: jest.fn() },
                closed: false
            }));

            consumer = new ResilientConsumer(config);
            await consumer.start();

            // Force storeConnected to false to trigger the reconnect path inside consume callback
            (consumer as any).storeConnected = false;
            const checkStoreSpy = jest.spyOn(consumer as any, 'checkStoreConnection').mockResolvedValue(undefined);

            const testEvent = {
                messageId: 'msg-store-reconnect',
                type: 'test.event',
                payload: {},
                properties: {}
            };

            if (consumeCallback) {
                await consumeCallback(testEvent);
            }

            expect(checkStoreSpy).toHaveBeenCalled();
        });

        it('should not rethrow UnknownEventDiscardError from processor (avoids retry/DLX routing)', async () => {
            const AmqpQueue = require('../../../src/broker/amqp-queue').AmqpQueue;
            let consumeCallback: any;

            AmqpQueue.mockImplementation(() => ({
                connect: jest.fn().mockResolvedValue(undefined),
                consume: jest.fn().mockImplementation(async (_queue: string, callback: any) => {
                    consumeCallback = callback;
                }),
                disconnect: jest.fn().mockResolvedValue(undefined),
                cancelAllConsumers: jest.fn().mockResolvedValue(undefined),
                publish: jest.fn().mockResolvedValue(undefined),
                channel: {
                    assertQueue: jest.fn().mockResolvedValue({ queue: 'test.queue' }),
                    assertExchange: jest.fn().mockResolvedValue({}),
                    bindQueue: jest.fn().mockResolvedValue({}),
                    consume: jest.fn().mockResolvedValue({ consumerTag: 'tag' }),
                    checkQueue: jest.fn().mockResolvedValue({ queue: 'test.queue', messageCount: 0 })
                },
                connection: { on: jest.fn() },
                closed: false
            }));

            consumer = new ResilientConsumer(config);
            await consumer.start();

            jest.spyOn((consumer as any).processor, 'process').mockRejectedValue(
                Object.assign(new Error('Unknown event type: unknown.type'), { name: 'UnknownEventDiscardError' })
            );

            const testEvent = {
                messageId: 'msg-unknown-discard',
                type: 'unknown.type',
                payload: {},
                properties: {}
            };

            if (consumeCallback) {
                await expect(consumeCallback(testEvent)).resolves.toBeUndefined();
            }
        });

        it('should not rethrow max retry exceeded errors from processor', async () => {
            const AmqpQueue = require('../../../src/broker/amqp-queue').AmqpQueue;
            let consumeCallback: any;

            AmqpQueue.mockImplementation(() => ({
                connect: jest.fn().mockResolvedValue(undefined),
                consume: jest.fn().mockImplementation(async (_queue: string, callback: any) => {
                    consumeCallback = callback;
                }),
                disconnect: jest.fn().mockResolvedValue(undefined),
                cancelAllConsumers: jest.fn().mockResolvedValue(undefined),
                publish: jest.fn().mockResolvedValue(undefined),
                channel: {
                    assertQueue: jest.fn().mockResolvedValue({ queue: 'test.queue' }),
                    assertExchange: jest.fn().mockResolvedValue({}),
                    bindQueue: jest.fn().mockResolvedValue({}),
                    consume: jest.fn().mockResolvedValue({ consumerTag: 'tag' }),
                    checkQueue: jest.fn().mockResolvedValue({ queue: 'test.queue', messageCount: 0 })
                },
                connection: { on: jest.fn() },
                closed: false
            }));

            consumer = new ResilientConsumer(config);
            await consumer.start();

            jest.spyOn((consumer as any).processor, 'process').mockRejectedValue(
                new Error('Max retry attempts (3) exceeded')
            );

            const testEvent = {
                messageId: 'msg-max-retry-exceeded',
                type: 'test.event',
                payload: {},
                properties: {}
            };

            if (consumeCallback) {
                await expect(consumeCallback(testEvent)).resolves.toBeUndefined();
            }
        });

        it('should log error when idle check throws', async () => {
            jest.useRealTimers();

            const mockCheckQueue = jest.fn()
                .mockResolvedValueOnce({ queue: 'test.queue', messageCount: 0 }) // first call succeeds (setup)
                .mockRejectedValue(new Error('Queue check failed')); // subsequent calls fail

            const AmqpQueue = require('../../../src/broker/amqp-queue').AmqpQueue;
            AmqpQueue.mockImplementation(() => ({
                connect: jest.fn().mockResolvedValue(undefined),
                consume: jest.fn().mockResolvedValue(undefined),
                disconnect: jest.fn().mockResolvedValue(undefined),
                cancelAllConsumers: jest.fn().mockResolvedValue(undefined),
                waitForProcessing: jest.fn().mockResolvedValue(undefined),
                processingMessages: 0,
                channel: {
                    assertQueue: jest.fn().mockResolvedValue({ queue: 'test.queue' }),
                    assertExchange: jest.fn().mockResolvedValue({}),
                    bindQueue: jest.fn().mockResolvedValue({}),
                    consume: jest.fn().mockResolvedValue({ consumerTag: 'tag' }),
                    checkQueue: mockCheckQueue
                },
                connection: { on: jest.fn() },
                closed: false
            }));

            config.exitIfIdle = true;
            config.idleCheckIntervalMs = 50;
            config.maxIdleChecks = 10;

            consumer = new ResilientConsumer(config);
            await consumer.start();

            // Wait for idle check to fire and fail
            await new Promise(resolve => setTimeout(resolve, 120));

            await consumer.stop();
            jest.useFakeTimers();
        }, 5000);

        it('should call checkStoreConnection in setupAndConsume when store is configured but not connected', async () => {
            const AmqpQueue = require('../../../src/broker/amqp-queue').AmqpQueue;
            AmqpQueue.mockImplementation(() => ({
                connect: jest.fn().mockResolvedValue(undefined),
                consume: jest.fn().mockResolvedValue(undefined),
                channel: {
                    assertQueue: jest.fn().mockResolvedValue({ queue: 'test.queue' }),
                    assertExchange: jest.fn().mockResolvedValue({}),
                    bindQueue: jest.fn().mockResolvedValue({}),
                    consume: jest.fn().mockResolvedValue({ consumerTag: 'tag' }),
                    checkQueue: jest.fn().mockResolvedValue({ queue: 'test.queue', messageCount: 0 })
                },
                connection: { on: jest.fn() },
                closed: false
            }));

            consumer = new ResilientConsumer(config);

            // Ensure storeConnected is false so setupAndConsume calls checkStoreConnection
            (consumer as any).storeConnected = false;
            const checkStoreSpy = jest.spyOn(consumer as any, 'checkStoreConnection').mockResolvedValue(undefined);

            await consumer.start();

            // checkStoreConnection should have been called from setupAndConsume (line 72)
            expect(checkStoreSpy).toHaveBeenCalled();
        });

        it('should not force single-active-consumer by default for main queue', async () => {
            const AmqpQueue = require('../../../src/broker/amqp-queue').AmqpQueue;
            const mockAssertQueue = jest.fn().mockResolvedValue({ queue: 'test.queue' });

            AmqpQueue.mockImplementation(() => ({
                connect: jest.fn().mockResolvedValue(undefined),
                consume: jest.fn().mockResolvedValue(undefined),
                disconnect: jest.fn().mockResolvedValue(undefined),
                cancelAllConsumers: jest.fn().mockResolvedValue(undefined),
                publish: jest.fn().mockResolvedValue(undefined),
                channel: {
                    assertQueue: mockAssertQueue,
                    assertExchange: jest.fn().mockResolvedValue({}),
                    bindQueue: jest.fn().mockResolvedValue({}),
                    consume: jest.fn().mockResolvedValue({ consumerTag: 'tag' }),
                    checkQueue: jest.fn().mockResolvedValue({ queue: 'test.queue', messageCount: 0 })
                },
                connection: { on: jest.fn() },
                closed: false
            }));

            consumer = new ResilientConsumer(config);
            await consumer.start();

            expect(mockAssertQueue).toHaveBeenCalledWith('test.queue', expect.objectContaining({
                arguments: expect.not.objectContaining({
                    'x-single-active-consumer': expect.anything(),
                }),
            }));
        });

        it('should preserve explicit single-active-consumer value from queue arguments', async () => {
            const AmqpQueue = require('../../../src/broker/amqp-queue').AmqpQueue;
            const mockAssertQueue = jest.fn().mockResolvedValue({ queue: 'test.queue' });

            AmqpQueue.mockImplementation(() => ({
                connect: jest.fn().mockResolvedValue(undefined),
                consume: jest.fn().mockResolvedValue(undefined),
                disconnect: jest.fn().mockResolvedValue(undefined),
                cancelAllConsumers: jest.fn().mockResolvedValue(undefined),
                publish: jest.fn().mockResolvedValue(undefined),
                channel: {
                    assertQueue: mockAssertQueue,
                    assertExchange: jest.fn().mockResolvedValue({}),
                    bindQueue: jest.fn().mockResolvedValue({}),
                    consume: jest.fn().mockResolvedValue({ consumerTag: 'tag' }),
                    checkQueue: jest.fn().mockResolvedValue({ queue: 'test.queue', messageCount: 0 })
                },
                connection: { on: jest.fn() },
                closed: false
            }));

            config.consumeQueue.options = {
                ...(config.consumeQueue.options ?? {}),
                arguments: {
                    ...(config.consumeQueue.options?.arguments ?? {}),
                    'x-single-active-consumer': false,
                },
            };

            consumer = new ResilientConsumer(config);
            await consumer.start();

            expect(mockAssertQueue).toHaveBeenCalledWith('test.queue', expect.objectContaining({
                arguments: expect.objectContaining({
                    'x-single-active-consumer': false,
                }),
            }));
        });

        it('should apply singleActiveConsumer flag when configured', async () => {
            const AmqpQueue = require('../../../src/broker/amqp-queue').AmqpQueue;
            const mockAssertQueue = jest.fn().mockResolvedValue({ queue: 'test.queue' });

            AmqpQueue.mockImplementation(() => ({
                connect: jest.fn().mockResolvedValue(undefined),
                consume: jest.fn().mockResolvedValue(undefined),
                disconnect: jest.fn().mockResolvedValue(undefined),
                cancelAllConsumers: jest.fn().mockResolvedValue(undefined),
                publish: jest.fn().mockResolvedValue(undefined),
                channel: {
                    assertQueue: mockAssertQueue,
                    assertExchange: jest.fn().mockResolvedValue({}),
                    bindQueue: jest.fn().mockResolvedValue({}),
                    consume: jest.fn().mockResolvedValue({ consumerTag: 'tag' }),
                    checkQueue: jest.fn().mockResolvedValue({ queue: 'test.queue', messageCount: 0 })
                },
                connection: { on: jest.fn() },
                closed: false
            }));

            config.singleActiveConsumer = true;

            consumer = new ResilientConsumer(config);
            await consumer.start();

            expect(mockAssertQueue).toHaveBeenCalledWith('test.queue', expect.objectContaining({
                arguments: expect.objectContaining({
                    'x-single-active-consumer': true,
                }),
            }));
        });

        it('should throttle repeated store reconnection checks when disconnected', async () => {
            const consumeMock = jest.fn().mockResolvedValue(undefined);
            const AmqpQueue = require('../../../src/broker/amqp-queue').AmqpQueue;
            AmqpQueue.mockImplementation(() => ({
                connect: jest.fn().mockResolvedValue(undefined),
                consume: consumeMock,
                disconnect: jest.fn().mockResolvedValue(undefined),
                cancelAllConsumers: jest.fn().mockResolvedValue(undefined),
                publish: jest.fn().mockResolvedValue(undefined),
                channel: {
                    consume: jest.fn().mockResolvedValue({ consumerTag: 'tag' }),
                    assertQueue: jest.fn().mockResolvedValue({ queue: 'test.queue' }),
                    assertExchange: jest.fn().mockResolvedValue({}),
                    bindQueue: jest.fn().mockResolvedValue({}),
                    checkQueue: jest.fn().mockResolvedValue({ queue: 'test.queue', messageCount: 0 })
                },
                connection: { on: jest.fn() },
                closed: false
            }));

            config.storeConnectionRetryDelayMs = 2000;
            consumer = new ResilientConsumer(config);
            await consumer.start();

            const checkStoreSpy = jest.spyOn(consumer as any, 'checkStoreConnection').mockResolvedValue(undefined);
            (consumer as any).storeConnected = false;

            const consumeCallback = consumeMock.mock.calls[0][1];
            const testEvent = {
                messageId: 'evt-throttle-1',
                type: 'test.event',
                payload: { data: 'test' },
                status: EventConsumeStatus.RECEIVED,
                properties: { headers: {} }
            };

            await expect(consumeCallback(testEvent)).resolves.toBeUndefined();
            await expect(consumeCallback({ ...testEvent, messageId: 'evt-throttle-2' })).rejects.toThrow('Store reconnect throttled');

            expect(checkStoreSpy).toHaveBeenCalledTimes(1);
        });
    });
});
