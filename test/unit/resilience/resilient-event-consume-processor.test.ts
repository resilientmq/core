import { ResilientEventConsumeProcessor } from '../../../src/resilience/resilient-event-consume-processor';
import { EventStoreMock } from '../../utils/event-store-mock';
import { EventMessage, MessageQueue, Middleware, RabbitMQResilientProcessorConfig } from '../../../src/types';
import { EventConsumeStatus } from '../../../src/types';

describe('ResilientEventConsumeProcessor', () => {
    let processor: ResilientEventConsumeProcessor;
    let mockStore: EventStoreMock;
    let mockBroker: jest.Mocked<MessageQueue>;
    let testEvent: EventMessage;
    let config: RabbitMQResilientProcessorConfig;

    beforeEach(() => {
        mockStore = new EventStoreMock();
        
        mockBroker = {
            connect: jest.fn(),
            publish: jest.fn(),
            consume: jest.fn(),
            disconnect: jest.fn(),
            close: jest.fn()
        } as any;

        testEvent = {
            messageId: 'msg-001',
            type: 'test.event',
            payload: { data: 'test' },
            status: EventConsumeStatus.RECEIVED,
            properties: {}
        };

        config = {
            connection: 'amqp://localhost:5672',
            broker: mockBroker,
            store: mockStore,
            consumeQueue: { queue: 'test.queue' },
            eventsToProcess: [
                {
                    type: 'test.event',
                    handler: jest.fn()
                }
            ]
        };
    });

    afterEach(() => {
        mockStore.clear();
        jest.clearAllMocks();
    });

    describe('process', () => {
        it('should process event with matching handler', async () => {
            const handler = jest.fn();
            config.eventsToProcess = [{ type: 'test.event', handler }];
            processor = new ResilientEventConsumeProcessor(config);

            await processor.process(testEvent);

            expect(handler).toHaveBeenCalledWith(testEvent);
        });

        it('should save event to store before processing', async () => {
            const handler = jest.fn();
            config.eventsToProcess = [{ type: 'test.event', handler }];
            processor = new ResilientEventConsumeProcessor(config);

            await processor.process(testEvent);

            expect(mockStore.getCallCount('saveEvent')).toBe(1);
            const savedEvent = await mockStore.getEvent(testEvent);
            expect(savedEvent).toBeDefined();
        });

        it('should update event status to PROCESSING before handler execution', async () => {
            const handler = jest.fn();
            config.eventsToProcess = [{ type: 'test.event', handler }];
            processor = new ResilientEventConsumeProcessor(config);

            await processor.process(testEvent);

            expect(mockStore.getCallCount('updateEventStatus')).toBeGreaterThanOrEqual(1);
        });

        it('should update event status to DONE after successful processing', async () => {
            const handler = jest.fn();
            config.eventsToProcess = [{ type: 'test.event', handler }];
            processor = new ResilientEventConsumeProcessor(config);

            await processor.process(testEvent);

            const savedEvent = await mockStore.getEvent(testEvent);
            expect(savedEvent?.status).toBe(EventConsumeStatus.DONE);
        });

        it('should skip duplicate events on first attempt', async () => {
            const handler = jest.fn();
            config.eventsToProcess = [{ type: 'test.event', handler }];
            processor = new ResilientEventConsumeProcessor(config);

            // Process event first time
            await processor.process(testEvent);
            
            // Try to process same event again (attempt 0)
            testEvent.properties = { headers: {} };
            await processor.process(testEvent);

            // Handler should only be called once
            expect(handler).toHaveBeenCalledTimes(1);
        });

        it('should process duplicate events on retry attempts', async () => {
            const handler = jest.fn();
            config.eventsToProcess = [{ type: 'test.event', handler }];
            processor = new ResilientEventConsumeProcessor(config);

            // Process event first time
            await processor.process(testEvent);
            
            // Simulate retry with x-death header
            testEvent.properties = {
                headers: {
                    'x-death': [{ count: 1 }]
                }
            };
            
            await processor.process(testEvent);

            // Handler should be called twice
            expect(handler).toHaveBeenCalledTimes(2);
        });

        it('should execute middleware before handler', async () => {
            const executionOrder: string[] = [];
            
            const middleware: Middleware = async (ctx, next) => {
                executionOrder.push('middleware');
                await next();
            };

            const handler = jest.fn(async () => {
                executionOrder.push('handler');
            });

            config.eventsToProcess = [{ type: 'test.event', handler }];
            config.middleware = [middleware];
            processor = new ResilientEventConsumeProcessor(config);

            await processor.process(testEvent);

            expect(executionOrder).toEqual(['middleware', 'handler']);
        });

        it('should handle errors in handler and update status to RETRY', async () => {
            const handler = jest.fn().mockRejectedValue(new Error('Handler error'));
            config.eventsToProcess = [{ type: 'test.event', handler }];
            config.retryQueue = { queue: 'retry.queue', maxAttempts: 3 };
            processor = new ResilientEventConsumeProcessor(config);

            await expect(processor.process(testEvent)).rejects.toThrow('Handler error');

            const savedEvent = await mockStore.getEvent(testEvent);
            expect(savedEvent?.status).toBe(EventConsumeStatus.RETRY);
        });

        it('should send to DLQ after max attempts exceeded', async () => {
            const handler = jest.fn().mockRejectedValue(new Error('Handler error'));
            config.eventsToProcess = [{ type: 'test.event', handler }];
            config.retryQueue = { queue: 'retry.queue', maxAttempts: 3 };
            config.deadLetterQueue = {
                queue: 'test.dlq',
                exchange: {
                    name: 'dlq.exchange',
                    type: 'direct',
                    options: { durable: true }
                }
            };
            processor = new ResilientEventConsumeProcessor(config);

            // Simulate 4th attempt (exceeds max of 3)
            testEvent.properties = {
                headers: {
                    'x-death': [{ count: 3 }]
                }
            };

            await processor.process(testEvent);

            expect(mockBroker.publish).toHaveBeenCalledWith(
                'test.dlq',
                expect.any(Object),
                expect.objectContaining({
                    exchange: config.deadLetterQueue.exchange
                })
            );
        });

        it('should update status to ERROR after sending to DLQ', async () => {
            const handler = jest.fn().mockRejectedValue(new Error('Handler error'));
            config.eventsToProcess = [{ type: 'test.event', handler }];
            config.retryQueue = { queue: 'retry.queue', maxAttempts: 3 };
            config.deadLetterQueue = {
                queue: 'test.dlq',
                exchange: {
                    name: 'dlq.exchange',
                    type: 'direct',
                    options: { durable: true }
                }
            };
            processor = new ResilientEventConsumeProcessor(config);

            testEvent.properties = {
                headers: {
                    'x-death': [{ count: 3 }]
                }
            };

            await processor.process(testEvent);

            const savedEvent = await mockStore.getEvent(testEvent);
            expect(savedEvent?.status).toBe(EventConsumeStatus.ERROR);
        });

        it('should call onEventStart hook before processing', async () => {
            const onEventStart = jest.fn();
            const handler = jest.fn();
            
            config.eventsToProcess = [{ type: 'test.event', handler }];
            config.events = { onEventStart };
            processor = new ResilientEventConsumeProcessor(config);

            await processor.process(testEvent);

            expect(onEventStart).toHaveBeenCalledWith(testEvent, expect.any(Object));
        });

        it('should skip event when onEventStart sets skipEvent flag', async () => {
            const onEventStart = jest.fn((event, control) => {
                control.skipEvent = true;
            });
            const handler = jest.fn();
            
            config.eventsToProcess = [{ type: 'test.event', handler }];
            config.events = { onEventStart };
            processor = new ResilientEventConsumeProcessor(config);

            await processor.process(testEvent);

            expect(handler).not.toHaveBeenCalled();
        });

        it('should call onSuccess hook after successful processing', async () => {
            const onSuccess = jest.fn();
            const handler = jest.fn();
            
            config.eventsToProcess = [{ type: 'test.event', handler }];
            config.events = { onSuccess };
            processor = new ResilientEventConsumeProcessor(config);

            await processor.process(testEvent);

            expect(onSuccess).toHaveBeenCalledWith(testEvent);
        });

        it('should call onError hook when processing fails', async () => {
            const onError = jest.fn();
            const handler = jest.fn().mockRejectedValue(new Error('Handler error'));
            
            config.eventsToProcess = [{ type: 'test.event', handler }];
            config.retryQueue = { queue: 'retry.queue', maxAttempts: 3 };
            config.events = { onError };
            processor = new ResilientEventConsumeProcessor(config);

            await expect(processor.process(testEvent)).rejects.toThrow();

            expect(onError).toHaveBeenCalledWith(testEvent, expect.any(Error));
        });

        it('should handle unknown event types gracefully', async () => {
            const handler = jest.fn();
            config.eventsToProcess = [{ type: 'other.event', handler }];
            processor = new ResilientEventConsumeProcessor(config);

            await processor.process(testEvent);

            expect(handler).not.toHaveBeenCalled();
            const savedEvent = await mockStore.getEvent(testEvent);
            expect(savedEvent?.status).toBe(EventConsumeStatus.DONE);
        });

        it('should delete unknown events when ignoreUnknownEvents is true', async () => {
            const handler = jest.fn();
            config.eventsToProcess = [{ type: 'other.event', handler }];
            config.ignoreUnknownEvents = true;
            processor = new ResilientEventConsumeProcessor(config);

            await processor.process(testEvent);

            expect(mockStore.getCallCount('deleteEvent')).toBe(1);
            const savedEvent = await mockStore.getEvent(testEvent);
            expect(savedEvent).toBeNull();
        });

        it('should work without store configured', async () => {
            const handler = jest.fn();
            config.store = undefined;
            config.eventsToProcess = [{ type: 'test.event', handler }];
            processor = new ResilientEventConsumeProcessor(config);

            await processor.process(testEvent);

            expect(handler).toHaveBeenCalled();
        });

        it('should extract attempt count from x-death headers', async () => {
            const handler = jest.fn();
            config.eventsToProcess = [{ type: 'test.event', handler }];
            config.retryQueue = { queue: 'retry.queue', maxAttempts: 5 };
            processor = new ResilientEventConsumeProcessor(config);

            testEvent.properties = {
                headers: {
                    'x-death': [{ count: 2 }]
                }
            };

            await processor.process(testEvent);

            expect(handler).toHaveBeenCalled();
        });

        it('should use default maxAttempts of 5 when not configured', async () => {
            const handler = jest.fn().mockRejectedValue(new Error('Handler error'));
            config.eventsToProcess = [{ type: 'test.event', handler }];
            config.retryQueue = { queue: 'retry.queue' };
            config.deadLetterQueue = {
                queue: 'test.dlq',
                exchange: {
                    name: 'dlq.exchange',
                    type: 'direct',
                    options: { durable: true }
                }
            };
            processor = new ResilientEventConsumeProcessor(config);

            // Simulate 6th attempt (exceeds default max of 5)
            testEvent.properties = {
                headers: {
                    'x-death': [{ count: 5 }]
                }
            };

            await processor.process(testEvent);

            expect(mockBroker.publish).toHaveBeenCalled();
        });
    });
});
