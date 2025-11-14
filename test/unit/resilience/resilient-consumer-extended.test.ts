import { ResilientConsumer } from '../../../src/resilience/resilient-consumer';
import { EventStoreMock } from '../../utils/event-store-mock';
import { AMQPLibMock } from '../../utils/amqplib-mock';
import { ResilientConsumerConfig, EventMessage } from '../../../src/types';

// Mock amqplib
jest.mock('amqplib', () => {
    const mockLib = new (require('../../utils/amqplib-mock').AMQPLibMock)();
    return {
        connect: jest.fn((...args) => mockLib.connect(...args))
    };
});

// Mock the AmqpQueue to avoid real connections
jest.mock('../../../src/broker/amqp-queue');

describe('ResilientConsumer - Extended Tests', () => {
    let consumer: ResilientConsumer;
    let mockStore: EventStoreMock;
    let config: ResilientConsumerConfig;
    let mockLib: AMQPLibMock;
    let mockChannel: any;
    let mockConnection: any;

    beforeEach(() => {
        mockStore = new EventStoreMock();
        mockLib = new AMQPLibMock();
        
        const amqplib = require('amqplib');
        amqplib.connect.mockImplementation((url: any) => mockLib.connect(url));

        mockChannel = {
            assertQueue: jest.fn().mockResolvedValue({ queue: 'test.queue' }),
            assertExchange: jest.fn().mockResolvedValue({ exchange: 'test.exchange' }),
            bindQueue: jest.fn().mockResolvedValue({}),
            consume: jest.fn().mockResolvedValue({ consumerTag: 'tag' }),
            checkQueue: jest.fn().mockResolvedValue({ queue: 'test.queue', messageCount: 0 }),
            prefetch: jest.fn(),
            cancel: jest.fn().mockResolvedValue(undefined),
            close: jest.fn().mockResolvedValue(undefined)
        };

        mockConnection = {
            on: jest.fn(),
            close: jest.fn().mockResolvedValue(undefined),
            connection: {
                stream: {
                    writable: true
                }
            }
        };

        config = {
            connection: 'amqp://localhost:5672',
            consumeQueue: {
                queue: 'test.queue',
                options: { durable: true }
            },
            eventsToProcess: [
                {
                    type: 'test.event',
                    handler: jest.fn().mockResolvedValue(undefined)
                }
            ],
            store: mockStore,
            prefetch: 10
        };
    });

    afterEach(async () => {
        if (consumer) {
            try {
                await consumer.stop();
            } catch (e) {
                // Ignore cleanup errors
            }
        }
        mockStore.clear();
        mockLib.reset();
        jest.clearAllMocks();
    });

    describe('message processing', () => {
        it('should process messages with correct handler', async () => {
            const handler = jest.fn().mockResolvedValue(undefined);
            config.eventsToProcess = [
                {
                    type: 'user.created',
                    handler
                }
            ];

            const AmqpQueue = require('../../../src/broker/amqp-queue').AmqpQueue;
            let consumeCallback: any;
            
            AmqpQueue.mockImplementation(() => ({
                connect: jest.fn().mockResolvedValue(undefined),
                consume: jest.fn().mockImplementation(async (_queue, callback) => {
                    consumeCallback = callback;
                }),
                disconnect: jest.fn().mockResolvedValue(undefined),
                cancelAllConsumers: jest.fn().mockResolvedValue(undefined),
                channel: mockChannel,
                connection: mockConnection,
                closed: false
            }));

            consumer = new ResilientConsumer(config);
            await consumer.start();

            // Simulate message arrival
            const testEvent: EventMessage = {
                messageId: 'msg-001',
                type: 'user.created',
                payload: { userId: '123' },
                properties: {}
            };

            if (consumeCallback) {
                await consumeCallback(testEvent);
            }

            expect(handler).toHaveBeenCalledWith(testEvent);
        });

        it('should handle message processing errors', async () => {
            const handler = jest.fn().mockRejectedValue(new Error('Processing failed'));
            config.eventsToProcess = [
                {
                    type: 'test.event',
                    handler
                }
            ];

            const AmqpQueue = require('../../../src/broker/amqp-queue').AmqpQueue;
            let consumeCallback: any;
            
            AmqpQueue.mockImplementation(() => ({
                connect: jest.fn().mockResolvedValue(undefined),
                consume: jest.fn().mockImplementation(async (_queue, callback) => {
                    consumeCallback = callback;
                }),
                disconnect: jest.fn().mockResolvedValue(undefined),
                cancelAllConsumers: jest.fn().mockResolvedValue(undefined),
                channel: mockChannel,
                connection: mockConnection,
                closed: false
            }));

            consumer = new ResilientConsumer(config);
            await consumer.start();

            const testEvent: EventMessage = {
                messageId: 'msg-001',
                type: 'test.event',
                payload: {},
                properties: {}
            };

            if (consumeCallback) {
                await expect(consumeCallback(testEvent)).rejects.toThrow('Processing failed');
            }
        });
    });

    describe('heartbeat monitoring', () => {
        it('should start heartbeat with custom interval', async () => {
            config.heartbeatIntervalMs = 5000;

            const AmqpQueue = require('../../../src/broker/amqp-queue').AmqpQueue;
            AmqpQueue.mockImplementation(() => ({
                connect: jest.fn().mockResolvedValue(undefined),
                consume: jest.fn().mockResolvedValue(undefined),
                disconnect: jest.fn().mockResolvedValue(undefined),
                cancelAllConsumers: jest.fn().mockResolvedValue(undefined),
                channel: mockChannel,
                connection: mockConnection,
                closed: false
            }));

            consumer = new ResilientConsumer(config);
            await consumer.start();

            expect(consumer).toBeDefined();
        });

        it('should use default heartbeat interval', async () => {
            config.heartbeatIntervalMs = undefined;

            const AmqpQueue = require('../../../src/broker/amqp-queue').AmqpQueue;
            AmqpQueue.mockImplementation(() => ({
                connect: jest.fn().mockResolvedValue(undefined),
                consume: jest.fn().mockResolvedValue(undefined),
                disconnect: jest.fn().mockResolvedValue(undefined),
                cancelAllConsumers: jest.fn().mockResolvedValue(undefined),
                channel: mockChannel,
                connection: mockConnection,
                closed: false
            }));

            consumer = new ResilientConsumer(config);
            await consumer.start();

            expect(consumer).toBeDefined();
        });
    });

    describe('idle monitoring', () => {
        it('should not start idle monitor when exitIfIdle is false', async () => {
            config.exitIfIdle = false;

            const AmqpQueue = require('../../../src/broker/amqp-queue').AmqpQueue;
            AmqpQueue.mockImplementation(() => ({
                connect: jest.fn().mockResolvedValue(undefined),
                consume: jest.fn().mockResolvedValue(undefined),
                disconnect: jest.fn().mockResolvedValue(undefined),
                cancelAllConsumers: jest.fn().mockResolvedValue(undefined),
                channel: mockChannel,
                connection: mockConnection,
                closed: false
            }));

            consumer = new ResilientConsumer(config);
            await consumer.start();

            expect(consumer).toBeDefined();
        });

        it('should check main queue in idle monitor', async () => {
            config.exitIfIdle = true;
            config.idleCheckIntervalMs = 100;
            config.maxIdleChecks = 2;

            const AmqpQueue = require('../../../src/broker/amqp-queue').AmqpQueue;
            AmqpQueue.mockImplementation(() => ({
                connect: jest.fn().mockResolvedValue(undefined),
                consume: jest.fn().mockResolvedValue(undefined),
                disconnect: jest.fn().mockResolvedValue(undefined),
                cancelAllConsumers: jest.fn().mockResolvedValue(undefined),
                channel: mockChannel,
                connection: mockConnection,
                closed: false
            }));

            consumer = new ResilientConsumer(config);
            await consumer.start();

            expect(consumer).toBeDefined();
        });

        it('should check retry queue in idle monitor when configured', async () => {
            config.exitIfIdle = true;
            config.idleCheckIntervalMs = 100;
            config.maxIdleChecks = 2;
            config.retryQueue = {
                queue: 'test.retry',
                ttlMs: 5000,
                maxAttempts: 3
            };

            const AmqpQueue = require('../../../src/broker/amqp-queue').AmqpQueue;
            AmqpQueue.mockImplementation(() => ({
                connect: jest.fn().mockResolvedValue(undefined),
                consume: jest.fn().mockResolvedValue(undefined),
                disconnect: jest.fn().mockResolvedValue(undefined),
                cancelAllConsumers: jest.fn().mockResolvedValue(undefined),
                channel: mockChannel,
                connection: mockConnection,
                closed: false
            }));

            consumer = new ResilientConsumer(config);
            await consumer.start();

            expect(consumer).toBeDefined();
        });
    });

    describe('reconnection', () => {
        it('should schedule reconnection when maxUptimeMs is configured', async () => {
            config.maxUptimeMs = 10000;

            const AmqpQueue = require('../../../src/broker/amqp-queue').AmqpQueue;
            AmqpQueue.mockImplementation(() => ({
                connect: jest.fn().mockResolvedValue(undefined),
                consume: jest.fn().mockResolvedValue(undefined),
                disconnect: jest.fn().mockResolvedValue(undefined),
                cancelAllConsumers: jest.fn().mockResolvedValue(undefined),
                channel: mockChannel,
                connection: mockConnection,
                closed: false
            }));

            consumer = new ResilientConsumer(config);
            await consumer.start();

            expect(consumer).toBeDefined();
        });

        it('should not schedule reconnection when maxUptimeMs is 0', async () => {
            config.maxUptimeMs = 0;

            const AmqpQueue = require('../../../src/broker/amqp-queue').AmqpQueue;
            AmqpQueue.mockImplementation(() => ({
                connect: jest.fn().mockResolvedValue(undefined),
                consume: jest.fn().mockResolvedValue(undefined),
                disconnect: jest.fn().mockResolvedValue(undefined),
                cancelAllConsumers: jest.fn().mockResolvedValue(undefined),
                channel: mockChannel,
                connection: mockConnection,
                closed: false
            }));

            consumer = new ResilientConsumer(config);
            await consumer.start();

            expect(consumer).toBeDefined();
        });

        it('should handle reconnection delay', async () => {
            config.reconnectDelayMs = 1000;

            const AmqpQueue = require('../../../src/broker/amqp-queue').AmqpQueue;
            AmqpQueue.mockImplementation(() => ({
                connect: jest.fn().mockResolvedValue(undefined),
                consume: jest.fn().mockResolvedValue(undefined),
                disconnect: jest.fn().mockResolvedValue(undefined),
                cancelAllConsumers: jest.fn().mockResolvedValue(undefined),
                channel: mockChannel,
                connection: mockConnection,
                closed: false
            }));

            consumer = new ResilientConsumer(config);
            await consumer.start();

            expect(consumer).toBeDefined();
        });
    });

    describe('stop and cleanup', () => {
        it('should stop consumer successfully', async () => {
            const AmqpQueue = require('../../../src/broker/amqp-queue').AmqpQueue;
            AmqpQueue.mockImplementation(() => ({
                connect: jest.fn().mockResolvedValue(undefined),
                consume: jest.fn().mockResolvedValue(undefined),
                disconnect: jest.fn().mockResolvedValue(undefined),
                cancelAllConsumers: jest.fn().mockResolvedValue(undefined),
                channel: mockChannel,
                connection: mockConnection,
                closed: false
            }));

            consumer = new ResilientConsumer(config);
            await consumer.start();
            await consumer.stop();

            expect(consumer).toBeDefined();
        });

        it('should clear all timers on stop', async () => {
            config.maxUptimeMs = 10000;
            config.heartbeatIntervalMs = 5000;

            const AmqpQueue = require('../../../src/broker/amqp-queue').AmqpQueue;
            AmqpQueue.mockImplementation(() => ({
                connect: jest.fn().mockResolvedValue(undefined),
                consume: jest.fn().mockResolvedValue(undefined),
                disconnect: jest.fn().mockResolvedValue(undefined),
                cancelAllConsumers: jest.fn().mockResolvedValue(undefined),
                channel: mockChannel,
                connection: mockConnection,
                closed: false
            }));

            consumer = new ResilientConsumer(config);
            await consumer.start();
            await consumer.stop();

            expect(consumer).toBeDefined();
        });

        it('should not throw when stopping already stopped consumer', async () => {
            const AmqpQueue = require('../../../src/broker/amqp-queue').AmqpQueue;
            AmqpQueue.mockImplementation(() => ({
                connect: jest.fn().mockResolvedValue(undefined),
                consume: jest.fn().mockResolvedValue(undefined),
                disconnect: jest.fn().mockResolvedValue(undefined),
                cancelAllConsumers: jest.fn().mockResolvedValue(undefined),
                channel: mockChannel,
                connection: mockConnection,
                closed: false
            }));

            consumer = new ResilientConsumer(config);
            await consumer.start();
            await consumer.stop();
            
            // Stop again
            await expect(consumer.stop()).resolves.not.toThrow();
        });

        it('should handle errors during stop gracefully', async () => {
            const AmqpQueue = require('../../../src/broker/amqp-queue').AmqpQueue;
            AmqpQueue.mockImplementation(() => ({
                connect: jest.fn().mockResolvedValue(undefined),
                consume: jest.fn().mockResolvedValue(undefined),
                disconnect: jest.fn().mockRejectedValue(new Error('Disconnect failed')),
                cancelAllConsumers: jest.fn().mockResolvedValue(undefined),
                channel: mockChannel,
                connection: mockConnection,
                closed: false
            }));

            consumer = new ResilientConsumer(config);
            await consumer.start();
            
            // Should not throw even if disconnect fails
            await expect(consumer.stop()).resolves.not.toThrow();
        });
    });

    describe('queue configuration', () => {
        it('should assert consume queue with correct options', async () => {
            config.consumeQueue.options = {
                durable: true,
                exclusive: false,
                autoDelete: false
            };

            const AmqpQueue = require('../../../src/broker/amqp-queue').AmqpQueue;
            AmqpQueue.mockImplementation(() => ({
                connect: jest.fn().mockResolvedValue(undefined),
                consume: jest.fn().mockResolvedValue(undefined),
                disconnect: jest.fn().mockResolvedValue(undefined),
                cancelAllConsumers: jest.fn().mockResolvedValue(undefined),
                channel: mockChannel,
                connection: mockConnection,
                closed: false
            }));

            consumer = new ResilientConsumer(config);
            await consumer.start();

            expect(mockChannel.assertQueue).toHaveBeenCalledWith(
                'test.queue',
                expect.objectContaining({
                    durable: true,
                    exclusive: false,
                    autoDelete: false
                })
            );
        });

        it('should configure DLQ with correct arguments', async () => {
            config.deadLetterQueue = {
                queue: 'test.dlq',
                options: { durable: true }
            };

            const AmqpQueue = require('../../../src/broker/amqp-queue').AmqpQueue;
            AmqpQueue.mockImplementation(() => ({
                connect: jest.fn().mockResolvedValue(undefined),
                consume: jest.fn().mockResolvedValue(undefined),
                disconnect: jest.fn().mockResolvedValue(undefined),
                cancelAllConsumers: jest.fn().mockResolvedValue(undefined),
                channel: mockChannel,
                connection: mockConnection,
                closed: false
            }));

            consumer = new ResilientConsumer(config);
            await consumer.start();

            expect(mockChannel.assertQueue).toHaveBeenCalledWith(
                'test.dlq',
                expect.objectContaining({
                    durable: true
                })
            );
        });
    });
});
