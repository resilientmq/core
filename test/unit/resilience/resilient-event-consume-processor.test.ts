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

        it('should process duplicate events on retry attempts using x-retry-count', async () => {
            const handler = jest.fn();
            config.eventsToProcess = [{ type: 'test.event', handler }];
            processor = new ResilientEventConsumeProcessor(config);

            // Process event first time
            await processor.process(testEvent);

            // Simulate retry with x-retry-count header (our managed counter)
            testEvent.properties = {
                headers: {
                    'x-retry-count': 1
                }
            };

            await processor.process(testEvent);

            // Handler should be called twice
            expect(handler).toHaveBeenCalledTimes(2);
        });

        it('should fall back to x-death headers when x-retry-count is absent (backward compat)', async () => {
            const handler = jest.fn();
            config.eventsToProcess = [{ type: 'test.event', handler }];
            processor = new ResilientEventConsumeProcessor(config);

            // Process event first time
            await processor.process(testEvent);

            // Simulate retry with x-death header (legacy/in-flight messages)
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

        it('should route to DLQ when handler fails and current attempt is the last one allowed', async () => {
            const handler = jest.fn().mockRejectedValue(new Error('Handler error on last allowed attempt'));
            config.eventsToProcess = [{ type: 'test.event', handler }];
            config.retryQueue = { queue: 'retry.queue', maxAttempts: 3 };
            config.deadLetterQueue = { queue: 'dlq.queue' };
            processor = new ResilientEventConsumeProcessor(config);

            // Setting retry to 2, and process() will increment attempt to 2+1 = 3, hit maxAttempts, and send to DLQ.
            testEvent.properties = {
                headers: { 'x-retry-count': 2 }
            };

            await processor.process(testEvent);

            expect(mockBroker.publish).toHaveBeenCalledWith(
                'dlq.queue',
                expect.any(Object),
                undefined
            );
        });

        it('should publish to retry queue on error (not throw)', async () => {
            const handler = jest.fn().mockRejectedValue(new Error('Handler error'));
            config.eventsToProcess = [{ type: 'test.event', handler }];
            config.retryQueue = { queue: 'retry.queue', maxAttempts: 3 };
            processor = new ResilientEventConsumeProcessor(config);

            // Should NOT throw — processor publishes to retry queue and ACKs
            await processor.process(testEvent);

            const savedEvent = await mockStore.getEvent(testEvent);
            expect(savedEvent?.status).toBe(EventConsumeStatus.RETRY);

            // Verify retry queue publish with incremented x-retry-count
            expect(mockBroker.publish).toHaveBeenCalledWith(
                'retry.queue',
                expect.objectContaining({
                    messageId: testEvent.messageId,
                    properties: expect.objectContaining({
                        headers: expect.objectContaining({
                            'x-retry-count': 1
                        })
                    })
                }),
                undefined
            );
        });

        it('should send to DLQ after max attempts exceeded via x-retry-count', async () => {
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

            // Pre-save event (simulates that it was stored during earlier processing attempts)
            await mockStore.saveEvent(testEvent);

            // Simulate 3rd retry (x-retry-count = 3, exceeds maxAttempts of 3)
            testEvent.properties = {
                headers: {
                    'x-retry-count': 3
                }
            };

            // Should NOT throw — message is sent to DLQ and ACK'd
            await processor.process(testEvent);

            // Store should be updated to ERROR status
            const savedEvent = await mockStore.getEvent(testEvent);
            expect(savedEvent?.status).toBe(EventConsumeStatus.ERROR);

            // Verify message was published to DLQ
            expect(mockBroker.publish).toHaveBeenCalledWith(
                'test.dlq',
                expect.objectContaining({
                    messageId: testEvent.messageId,
                    type: testEvent.type
                }),
                expect.objectContaining({
                    exchange: expect.objectContaining({
                        name: 'dlq.exchange'
                    })
                })
            );
        });

        it('should hard guard at entry when x-retry-count >= maxAttempts', async () => {
            const handler = jest.fn();
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

            // Simulate already exceeding max (e.g., race condition set it to 100)
            testEvent.properties = {
                headers: {
                    'x-retry-count': 100
                }
            };

            // Should NOT throw, should NOT call handler
            await processor.process(testEvent);

            // Handler must NOT have been called
            expect(handler).not.toHaveBeenCalled();

            // Message should be routed to DLQ
            expect(mockBroker.publish).toHaveBeenCalledWith(
                'test.dlq',
                expect.objectContaining({
                    messageId: testEvent.messageId
                }),
                expect.objectContaining({
                    exchange: expect.objectContaining({
                        name: 'dlq.exchange'
                    })
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

            // Pre-save event (simulates that it was stored during earlier processing attempts)
            await mockStore.saveEvent(testEvent);

            testEvent.properties = {
                headers: {
                    'x-retry-count': 3
                }
            };

            // Should NOT throw — message is sent to DLQ and ACK'd
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

            // Should NOT throw anymore — processor publishes to retry queue
            await processor.process(testEvent);

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



        it('should work without store configured', async () => {
            const handler = jest.fn();
            config.store = undefined;
            config.eventsToProcess = [{ type: 'test.event', handler }];
            processor = new ResilientEventConsumeProcessor(config);

            await processor.process(testEvent);

            expect(handler).toHaveBeenCalled();
        });

        it('should prefer x-retry-count over x-death headers', async () => {
            const handler = jest.fn();
            config.eventsToProcess = [{ type: 'test.event', handler }];
            config.retryQueue = { queue: 'retry.queue', maxAttempts: 5 };
            processor = new ResilientEventConsumeProcessor(config);

            // Both headers present — x-retry-count should take precedence
            testEvent.properties = {
                headers: {
                    'x-retry-count': 2,
                    'x-death': [{ count: 50 }] // This would cause issues if used
                }
            };

            await processor.process(testEvent);

            // Should process normally because x-retry-count (2) < maxAttempts (5)
            expect(handler).toHaveBeenCalled();
        });

        it('should use default maxAttempts of 3 when not configured', async () => {
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

            // Pre-save event (simulates that it was stored during earlier processing attempts)
            await mockStore.saveEvent(testEvent);

            // Simulate exceeding default max of 3
            testEvent.properties = {
                headers: {
                    'x-retry-count': 3
                }
            };

            // Should NOT throw — message is sent to DLQ and ACK'd
            await processor.process(testEvent);

            // Verify status was updated to ERROR
            const savedEvent = await mockStore.getEvent(testEvent);
            expect(savedEvent?.status).toBe(EventConsumeStatus.ERROR);

            // Verify message was published to DLQ
            expect(mockBroker.publish).toHaveBeenCalled();
        });

        it('should increment x-retry-count on each retry', async () => {
            const handler = jest.fn().mockRejectedValue(new Error('Handler error'));
            config.eventsToProcess = [{ type: 'test.event', handler }];
            config.retryQueue = { queue: 'retry.queue', maxAttempts: 5 };
            processor = new ResilientEventConsumeProcessor(config);

            // First failure (retryCount = 0)
            await processor.process(testEvent);

            expect(mockBroker.publish).toHaveBeenCalledWith(
                'retry.queue',
                expect.objectContaining({
                    properties: expect.objectContaining({
                        headers: expect.objectContaining({
                            'x-retry-count': 1
                        })
                    })
                }),
                undefined
            );

            // Simulate second failure (retryCount = 1)
            mockBroker.publish.mockClear();
            testEvent.properties = {
                headers: { 'x-retry-count': 1 }
            };

            await processor.process(testEvent);

            expect(mockBroker.publish).toHaveBeenCalledWith(
                'retry.queue',
                expect.objectContaining({
                    properties: expect.objectContaining({
                        headers: expect.objectContaining({
                            'x-retry-count': 2
                        })
                    })
                }),
                undefined
            );
        });

        it('should discard message when max retries exceeded and no DLQ configured', async () => {
            const handler = jest.fn();
            config.eventsToProcess = [{ type: 'test.event', handler }];
            config.retryQueue = { queue: 'retry.queue', maxAttempts: 3 };
            // No deadLetterQueue configured
            processor = new ResilientEventConsumeProcessor(config);

            // Pre-save event (simulates that it was stored during earlier processing attempts)
            await mockStore.saveEvent(testEvent);

            testEvent.properties = {
                headers: {
                    'x-retry-count': 3
                }
            };

            // Should NOT throw — message is discarded (ACK'd)
            await processor.process(testEvent);

            // Handler must NOT have been called (hard guard)
            expect(handler).not.toHaveBeenCalled();

            // No DLQ publish should happen
            expect(mockBroker.publish).not.toHaveBeenCalled();

            // Store should be updated to ERROR
            const savedEvent = await mockStore.getEvent(testEvent);
            expect(savedEvent?.status).toBe(EventConsumeStatus.ERROR);
        });

        it('should treat NaN x-retry-count as 0 (first attempt)', async () => {
            const handler = jest.fn();
            config.eventsToProcess = [{ type: 'test.event', handler }];
            processor = new ResilientEventConsumeProcessor(config);

            testEvent.properties = {
                headers: {
                    'x-retry-count': NaN
                }
            };

            await processor.process(testEvent);

            // NaN is treated as 0 (first attempt), so handler should be called
            expect(handler).toHaveBeenCalledWith(testEvent);
        });

        it('should treat negative x-retry-count as 0 (first attempt)', async () => {
            const handler = jest.fn();
            config.eventsToProcess = [{ type: 'test.event', handler }];
            processor = new ResilientEventConsumeProcessor(config);

            testEvent.properties = {
                headers: {
                    'x-retry-count': -5
                }
            };

            await processor.process(testEvent);

            expect(handler).toHaveBeenCalledWith(testEvent);
        });

        it('should accept string x-retry-count and coerce to number', async () => {
            const handler = jest.fn();
            config.eventsToProcess = [{ type: 'test.event', handler }];
            config.retryQueue = { queue: 'retry.queue', maxAttempts: 3 };
            config.deadLetterQueue = {
                queue: 'test.dlq',
                exchange: { name: 'dlq.exchange', type: 'direct', options: { durable: true } }
            };
            processor = new ResilientEventConsumeProcessor(config);

            await mockStore.saveEvent(testEvent);

            testEvent.properties = {
                headers: {
                    'x-retry-count': '5' as any // String coerced to 5
                }
            };

            await processor.process(testEvent);

            // 5 >= 3, so hard guard should fire, handler NOT called
            expect(handler).not.toHaveBeenCalled();
            expect(mockBroker.publish).toHaveBeenCalled();
        });

        it('should ACK (not throw) when retry queue publish fails (safety net)', async () => {
            const handler = jest.fn().mockRejectedValue(new Error('Handler error'));
            config.eventsToProcess = [{ type: 'test.event', handler }];
            config.retryQueue = { queue: 'retry.queue', maxAttempts: 5 };
            processor = new ResilientEventConsumeProcessor(config);

            // Make broker.publish fail — this simulates the retry queue being down
            mockBroker.publish.mockRejectedValue(new Error('AMQP connection lost'));

            // Should NOT throw — safety net catches internal error and ACKs
            await processor.process(testEvent);

            // Handler was called and failed
            expect(handler).toHaveBeenCalled();
        });

        it('should route to DLQ when no retry queue configured and handler fails', async () => {
            const handler = jest.fn().mockRejectedValue(new Error('Handler error'));
            config.eventsToProcess = [{ type: 'test.event', handler }];
            // No retryQueue configured
            config.deadLetterQueue = {
                queue: 'test.dlq',
                exchange: { name: 'dlq.exchange', type: 'direct', options: { durable: true } }
            };
            processor = new ResilientEventConsumeProcessor(config);

            await processor.process(testEvent);

            // Handler was called
            expect(handler).toHaveBeenCalled();

            // Message should be sent to DLQ since no retry queue exists
            expect(mockBroker.publish).toHaveBeenCalledWith(
                'test.dlq',
                expect.objectContaining({
                    messageId: testEvent.messageId
                }),
                expect.objectContaining({
                    exchange: expect.objectContaining({
                        name: 'dlq.exchange'
                    })
                })
            );
        });

        it('should discard when no retry queue and no DLQ configured and handler fails', async () => {
            const handler = jest.fn().mockRejectedValue(new Error('Handler error'));
            config.eventsToProcess = [{ type: 'test.event', handler }];
            // No retryQueue and no deadLetterQueue
            processor = new ResilientEventConsumeProcessor(config);

            // Should NOT throw
            await processor.process(testEvent);

            expect(handler).toHaveBeenCalled();
            // No publish since neither retry nor DLQ configured
            expect(mockBroker.publish).not.toHaveBeenCalled();
        });
    });
});
