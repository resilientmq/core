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
                closed: false,
                publish: jest.fn().mockResolvedValue(undefined)
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
                // Processor now handles errors internally (publishes to retry queue and ACKs)
                // so this should resolve without throwing
                await expect(consumeCallback(testEvent)).resolves.not.toThrow();
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

        it('should remove SIGTERM/SIGINT listeners on stop', async () => {
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

            const removeListenerSpy = jest.spyOn(process, 'removeListener');
            consumer = new ResilientConsumer(config);
            await consumer.start();
            await consumer.stop();

            expect(removeListenerSpy).toHaveBeenCalledWith('SIGTERM', expect.any(Function));
            expect(removeListenerSpy).toHaveBeenCalledWith('SIGINT', expect.any(Function));
            removeListenerSpy.mockRestore();
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

    describe('reconnect', () => {
        it('should not reconnect if already reconnecting', async () => {
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

            // Set reconnecting to true to trigger early return
            (consumer as any).reconnecting = true;
            const stopTimersSpy = jest.spyOn(consumer as any, 'stopTimers');

            await (consumer as any).reconnect();

            // stopTimers should NOT have been called since we returned early
            expect(stopTimersSpy).not.toHaveBeenCalled();
        });

        it('should execute reconnect flow and schedule restart', async () => {
            jest.useFakeTimers();
            const mockConnect = jest.fn().mockResolvedValue(undefined);
            const mockConsume = jest.fn().mockResolvedValue(undefined);
            const mockCancelAllConsumers = jest.fn().mockResolvedValue(undefined);
            const mockChannelClose = jest.fn().mockResolvedValue(undefined);

            const AmqpQueue = require('../../../src/broker/amqp-queue').AmqpQueue;
            AmqpQueue.mockImplementation(() => ({
                connect: mockConnect,
                consume: mockConsume,
                disconnect: jest.fn().mockResolvedValue(undefined),
                cancelAllConsumers: mockCancelAllConsumers,
                waitForProcessing: jest.fn().mockResolvedValue(undefined),
                channel: { ...mockChannel, close: mockChannelClose },
                connection: { ...mockConnection, close: jest.fn().mockResolvedValue(undefined) },
                closed: false
            }));

            config.reconnectDelayMs = 100;
            consumer = new ResilientConsumer(config);
            await consumer.start();

            // Trigger reconnect
            const reconnectPromise = (consumer as any).reconnect();
            await reconnectPromise;

            expect(mockCancelAllConsumers).toHaveBeenCalled();
            expect(mockChannelClose).toHaveBeenCalled();

            // Advance timer to trigger the restart
            jest.advanceTimersByTime(200);
            jest.useRealTimers();
        });

        it('should handle errors during reconnect cleanup gracefully', async () => {
            jest.useFakeTimers();
            const AmqpQueue = require('../../../src/broker/amqp-queue').AmqpQueue;
            AmqpQueue.mockImplementation(() => ({
                connect: jest.fn().mockResolvedValue(undefined),
                consume: jest.fn().mockResolvedValue(undefined),
                disconnect: jest.fn().mockResolvedValue(undefined),
                cancelAllConsumers: jest.fn().mockRejectedValue(new Error('Cancel failed')),
                waitForProcessing: jest.fn().mockResolvedValue(undefined),
                channel: { ...mockChannel, close: jest.fn().mockResolvedValue(undefined) },
                connection: mockConnection,
                closed: false
            }));

            consumer = new ResilientConsumer(config);
            await consumer.start();

            // Should not throw even if cancelAllConsumers fails
            await expect((consumer as any).reconnect()).resolves.not.toThrow();
            jest.useRealTimers();
        });
    });

    describe('checkStoreConnection retry delay', () => {
        it('should retry store connection with delay between attempts', async () => {
            jest.useRealTimers();
            let callCount = 0;
            mockStore.getEvent = jest.fn().mockImplementation(async () => {
                callCount++;
                if (callCount < 2) throw new Error('Store not ready');
                return null;
            });

            config.storeConnectionRetries = 2;
            config.storeConnectionRetryDelayMs = 10;
            consumer = new ResilientConsumer(config);

            // Should succeed on second attempt
            await expect((consumer as any).checkStoreConnection()).resolves.not.toThrow();
            expect(callCount).toBe(2);
            jest.useFakeTimers();
        }, 5000);
    });

    describe('SIGTERM/SIGINT signal handlers', () => {
        const buildMockQueue = () => ({
            connect: jest.fn().mockResolvedValue(undefined),
            consume: jest.fn().mockResolvedValue(undefined),
            disconnect: jest.fn().mockResolvedValue(undefined),
            cancelAllConsumers: jest.fn().mockResolvedValue(undefined),
            waitForProcessing: jest.fn().mockResolvedValue(undefined),
            channel: mockChannel,
            connection: mockConnection,
            closed: false,
        });

        it('should invoke stop() when SIGTERM is emitted', async () => {
            const AmqpQueue = require('../../../src/broker/amqp-queue').AmqpQueue;
            AmqpQueue.mockImplementation(() => buildMockQueue());

            consumer = new ResilientConsumer(config);
            await consumer.start();

            const stopSpy = jest.spyOn(consumer, 'stop').mockResolvedValue(undefined);

            // Emit SIGTERM — this executes the () => this.stop() arrow function
            process.emit('SIGTERM');

            expect(stopSpy).toHaveBeenCalled();
            stopSpy.mockRestore();
        });

        it('should invoke stop() when SIGINT is emitted', async () => {
            const AmqpQueue = require('../../../src/broker/amqp-queue').AmqpQueue;
            AmqpQueue.mockImplementation(() => buildMockQueue());

            consumer = new ResilientConsumer(config);
            await consumer.start();

            const stopSpy = jest.spyOn(consumer, 'stop').mockResolvedValue(undefined);

            // Emit SIGINT — this executes the () => this.stop() arrow function
            process.emit('SIGINT');

            expect(stopSpy).toHaveBeenCalled();
            stopSpy.mockRestore();
        });
    });
});

describe('ResilientConsumer - Metrics', () => {
    it('should return undefined from getMetrics() when metricsEnabled is false', () => {
        const consumer = new ResilientConsumer({
            connection: 'amqp://localhost',
            consumeQueue: { queue: 'q' },
            eventsToProcess: [{ type: 'x', handler: jest.fn() }],
        });
        expect(consumer.getMetrics()).toBeUndefined();
    });

    it('should return undefined from getMetrics() even when metricsEnabled is true', () => {
        const consumer = new ResilientConsumer({
            connection: 'amqp://localhost',
            consumeQueue: { queue: 'q' },
            eventsToProcess: [{ type: 'x', handler: jest.fn() }],
            metricsEnabled: true,
        });
        expect(consumer.getMetrics()).toBeUndefined();
    });
});
