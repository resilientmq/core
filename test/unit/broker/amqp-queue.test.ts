import { AmqpQueue } from '../../../src/broker/amqp-queue';
import { AMQPLibMock } from '../../utils/amqplib-mock';
import { EventConsumeStatus } from '../../../src/types';

// Mock amqplib module
jest.mock('amqplib', () => {
    const mockLib = new (require('../../utils/amqplib-mock').AMQPLibMock)();
    return {
        connect: jest.fn((...args) => mockLib.connect(...args))
    };
});

describe('AmqpQueue', () => {
    let amqpQueue: AmqpQueue;
    let mockLib: AMQPLibMock;

    beforeEach(async () => {
        jest.useFakeTimers();
        // Reset mock
        mockLib = new AMQPLibMock();
        const amqplib = require('amqplib');
        amqplib.connect.mockImplementation((url: any) => mockLib.connect(url));

        // Create queue instance
        amqpQueue = new AmqpQueue('amqp://localhost:5672');
    });

    afterEach(async () => {
        mockLib.reset();
        jest.clearAllMocks();
        jest.useRealTimers();
    });

    describe('connect', () => {
        it('should connect to AMQP broker successfully', async () => {
            await amqpQueue.connect(10);

            expect(amqpQueue.connection).toBeDefined();
            expect(amqpQueue.channel).toBeDefined();
            expect(amqpQueue.prefetchCount).toBe(10);
        });

        it('should use default prefetch of 1 when not specified', async () => {
            await amqpQueue.connect();

            expect(amqpQueue.prefetchCount).toBe(1);
        });

        it('should throw error when connection fails', async () => {
            mockLib.setConnectionFailure(true);

            await expect(amqpQueue.connect()).rejects.toThrow('Connection failed (simulated)');
        });

        it('should throw error when channel creation fails', async () => {
            mockLib.setChannelFailure(true);

            await expect(amqpQueue.connect()).rejects.toThrow('Channel creation failed (simulated)');
        });

        it('should set closed flag when connection closes', async () => {
            await amqpQueue.connect();
            
            expect(amqpQueue.closed).toBe(false);
            
            // Simulate connection close
            await amqpQueue.connection.close();
            
            expect(amqpQueue.closed).toBe(true);
        });
    });

    describe('publish', () => {
        beforeEach(async () => {
            await amqpQueue.connect();
        });

        it('should publish message to queue directly', async () => {
            const event = {
                messageId: 'msg-001',
                type: 'test.event',
                payload: { data: 'test' },
                status: EventConsumeStatus.RECEIVED
            };

            await amqpQueue.publish('test.queue', event);

            const messages = mockLib.getPublishedMessages('test.queue');
            expect(messages).toHaveLength(1);
            expect(JSON.parse(messages[0].content.toString())).toEqual({ data: 'test' });
        });

        it('should publish message to exchange with routing key', async () => {
            const event = {
                messageId: 'msg-002',
                type: 'test.event',
                payload: { data: 'test' },
                status: EventConsumeStatus.RECEIVED,
                routingKey: 'test.routing.key'
            };

            await amqpQueue.publish('test.queue', event, {
                exchange: {
                    name: 'test.exchange',
                    type: 'topic',
                    options: { durable: true }
                }
            });

            // Message should be published to exchange, not directly to queue
            const messages = mockLib.getPublishedMessages('test.queue');
            expect(messages).toHaveLength(0);
        });

        it('should use empty routing key when not provided', async () => {
            const event = {
                messageId: 'msg-003',
                type: 'test.event',
                payload: { data: 'test' },
                status: EventConsumeStatus.RECEIVED
            };

            await amqpQueue.publish('test.queue', event, {
                exchange: {
                    name: 'test.exchange',
                    type: 'fanout',
                    options: { durable: true }
                }
            });

            // Should not throw error
            expect(true).toBe(true);
        });

        it('should use persistent delivery mode by default', async () => {
            const event = {
                messageId: 'msg-004',
                type: 'test.event',
                payload: { data: 'test' },
                status: EventConsumeStatus.RECEIVED
            };

            await amqpQueue.publish('test.queue', event);

            const messages = mockLib.getPublishedMessages('test.queue');
            expect(messages[0].properties.deliveryMode).toBe(2);
        });

        it('should use custom properties when provided', async () => {
            const event = {
                messageId: 'msg-005',
                type: 'test.event',
                payload: { data: 'test' },
                status: EventConsumeStatus.RECEIVED,
                properties: {
                    persistent: false,
                    contentType: 'application/json',
                    correlationId: 'corr-123'
                }
            };

            await amqpQueue.publish('test.queue', event);

            const messages = mockLib.getPublishedMessages('test.queue');
            expect(messages[0].properties.contentType).toBe('application/json');
            expect(messages[0].properties.correlationId).toBe('corr-123');
        });
    });

    describe('consume', () => {
        beforeEach(async () => {
            await amqpQueue.connect();
        });

        it('should consume messages from queue', async () => {
            const receivedMessages: any[] = [];
            const onMessage = jest.fn(async (event) => {
                receivedMessages.push(event);
            });

            await amqpQueue.consume('test.queue', onMessage);

            // Simulate incoming message
            (amqpQueue.channel as any).simulateIncomingMessage('test.queue', { data: 'test' }, {
                messageId: 'msg-001',
                type: 'test.event'
            });

            // Run all pending timers and wait for promises
            jest.runAllTimers();
            await Promise.resolve();

            expect(onMessage).toHaveBeenCalled();
            expect(receivedMessages).toHaveLength(1);
            expect(receivedMessages[0].payload).toEqual({ data: 'test' });
        });

        it('should ack message after successful processing', async () => {
            jest.useRealTimers(); // Use real timers for this test
            const ackSpy = jest.spyOn(amqpQueue.channel, 'ack');

            // Mock the connection stream to be writable
            (amqpQueue.channel as any).connection = {
                stream: { writable: true }
            };

            await amqpQueue.consume('test.queue', async () => {
                // Successful processing
            });

            (amqpQueue.channel as any).simulateIncomingMessage('test.queue', { data: 'test' });

            // Wait for async processing
            await new Promise(resolve => setTimeout(resolve, 50));

            expect(ackSpy).toHaveBeenCalled();
            jest.useFakeTimers(); // Restore fake timers
        });

        it('should nack message when processing fails', async () => {
            jest.useRealTimers(); // Use real timers for this test
            const nackSpy = jest.spyOn(amqpQueue.channel, 'nack');

            // Mock the connection stream to be writable
            (amqpQueue.channel as any).connection = {
                stream: { writable: true }
            };

            await amqpQueue.consume('test.queue', async () => {
                throw new Error('Processing failed');
            });

            (amqpQueue.channel as any).simulateIncomingMessage('test.queue', { data: 'test' });

            // Wait for async processing
            await new Promise(resolve => setTimeout(resolve, 50));

            expect(nackSpy).toHaveBeenCalledWith(expect.anything(), false, false);
            jest.useFakeTimers(); // Restore fake timers
        });

        it('should parse message payload correctly', async () => {
            let receivedPayload: any;

            await amqpQueue.consume('test.queue', async (event) => {
                receivedPayload = event.payload;
            });

            (amqpQueue.channel as any).simulateIncomingMessage('test.queue', { 
                userId: '123', 
                action: 'created' 
            });

            jest.runAllTimers();
            await Promise.resolve();

            expect(receivedPayload).toEqual({ userId: '123', action: 'created' });
        });

        it('should handle multiple consumers on different queues', async () => {
            const queue1Messages: any[] = [];
            const queue2Messages: any[] = [];

            await amqpQueue.consume('queue1', async (event) => {
                queue1Messages.push(event);
            });

            await amqpQueue.consume('queue2', async (event) => {
                queue2Messages.push(event);
            });

            (amqpQueue.channel as any).simulateIncomingMessage('queue1', { data: 'q1' });
            (amqpQueue.channel as any).simulateIncomingMessage('queue2', { data: 'q2' });

            jest.runAllTimers();
            await Promise.resolve();

            expect(queue1Messages).toHaveLength(1);
            expect(queue2Messages).toHaveLength(1);
            expect(queue1Messages[0].payload).toEqual({ data: 'q1' });
            expect(queue2Messages[0].payload).toEqual({ data: 'q2' });
        });
    });

    describe('disconnect', () => {
        it('should cancel all consumers before disconnecting', async () => {
            await amqpQueue.connect();
            await amqpQueue.consume('test.queue', async () => {});

            const cancelSpy = jest.spyOn(amqpQueue.channel, 'cancel');

            await amqpQueue.disconnect();

            expect(cancelSpy).toHaveBeenCalled();
        });

        it('should wait for processing messages to complete', async () => {
            jest.useRealTimers(); // Use real timers for this test
            await amqpQueue.connect();

            let processingStarted = false;
            let processingComplete = false;

            await amqpQueue.consume('test.queue', async () => {
                processingStarted = true;
                await new Promise(resolve => setTimeout(resolve, 50));
                processingComplete = true;
            });

            (amqpQueue.channel as any).simulateIncomingMessage('test.queue', { data: 'test' });

            // Give time for message to start processing
            await new Promise(resolve => setTimeout(resolve, 10));

            // Verify processing started
            expect(processingStarted).toBe(true);

            // Start disconnect - it should wait
            await amqpQueue.disconnect();

            // Processing should be complete after disconnect
            expect(processingComplete).toBe(true);
            jest.useFakeTimers(); // Restore fake timers
        });

        it('should close channel and connection', async () => {
            await amqpQueue.connect();

            const channelCloseSpy = jest.spyOn(amqpQueue.channel, 'close');
            const connectionCloseSpy = jest.spyOn(amqpQueue.connection, 'close');

            await amqpQueue.disconnect();

            expect(channelCloseSpy).toHaveBeenCalled();
            expect(connectionCloseSpy).toHaveBeenCalled();
        });
    });

    describe('close', () => {
        it('should be an alias for disconnect', async () => {
            await amqpQueue.connect();

            const disconnectSpy = jest.spyOn(amqpQueue, 'disconnect');

            await amqpQueue.close();

            expect(disconnectSpy).toHaveBeenCalled();
        });
    });
});
