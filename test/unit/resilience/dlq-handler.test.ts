import { handleDLQ } from '../../../src/resilience/dlq-handler';
import { EventMessage, MessageQueue } from '../../../src/types';
import { EventConsumeStatus } from '../../../src/types';

describe('DLQHandler', () => {
    let mockBroker: jest.Mocked<MessageQueue>;
    let testEvent: EventMessage;

    beforeEach(() => {
        // Create mock broker
        mockBroker = {
            connect: jest.fn(),
            publish: jest.fn(),
            consume: jest.fn(),
            disconnect: jest.fn(),
            close: jest.fn()
        } as any;

        // Create test event
        testEvent = {
            messageId: 'msg-001',
            type: 'test.event',
            payload: { data: 'test' },
            status: EventConsumeStatus.ERROR,
            properties: {
                messageId: 'msg-001',
                type: 'test.event'
            }
        };
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    describe('handleDLQ', () => {
        it('should send message to DLQ when configured', async () => {
            const dlqConfig = {
                queue: 'test.dlq',
                exchange: {
                    name: 'dlq.exchange',
                    type: 'direct' as const,
                    options: { durable: true }
                }
            };

            await handleDLQ(dlqConfig, mockBroker, testEvent);

            expect(mockBroker.publish).toHaveBeenCalledWith(
                'test.dlq',
                expect.objectContaining({
                    messageId: 'msg-001',
                    type: 'test.event'
                }),
                { exchange: dlqConfig.exchange }
            );
        });

        it('should include error information in headers', async () => {
            const dlqConfig = {
                queue: 'test.dlq',
                exchange: {
                    name: 'dlq.exchange',
                    type: 'direct' as const,
                    options: { durable: true }
                }
            };

            const error = new Error('Processing failed');
            error.name = 'ProcessingError';

            await handleDLQ(dlqConfig, mockBroker, testEvent, error, 3, 'original.queue');

            expect(mockBroker.publish).toHaveBeenCalled();
            const publishedEvent = mockBroker.publish.mock.calls[0][1];
            
            expect(publishedEvent.properties?.headers).toMatchObject({
                'x-error-message': 'Processing failed',
                'x-error-name': 'ProcessingError',
                'x-death-count': 3,
                'x-original-queue': 'original.queue'
            });
        });

        it('should include death reason in headers', async () => {
            const dlqConfig = {
                queue: 'test.dlq',
                exchange: {
                    name: 'dlq.exchange',
                    type: 'direct' as const,
                    options: { durable: true }
                }
            };

            await handleDLQ(dlqConfig, mockBroker, testEvent, undefined, 1, 'test.queue');

            const publishedEvent = mockBroker.publish.mock.calls[0][1];
            expect(publishedEvent.properties?.headers?.['x-death-reason']).toBe('expired');
        });

        it('should set death reason to rejected when error is provided', async () => {
            const dlqConfig = {
                queue: 'test.dlq',
                exchange: {
                    name: 'dlq.exchange',
                    type: 'direct' as const,
                    options: { durable: true }
                }
            };

            const error = new Error('Test error');

            await handleDLQ(dlqConfig, mockBroker, testEvent, error);

            const publishedEvent = mockBroker.publish.mock.calls[0][1];
            expect(publishedEvent.properties?.headers?.['x-death-reason']).toBe('rejected');
        });

        it('should preserve existing event properties', async () => {
            const dlqConfig = {
                queue: 'test.dlq',
                exchange: {
                    name: 'dlq.exchange',
                    type: 'direct' as const,
                    options: { durable: true }
                }
            };

            testEvent.properties = {
                ...testEvent.properties,
                correlationId: 'corr-123',
                contentType: 'application/json'
            };

            await handleDLQ(dlqConfig, mockBroker, testEvent);

            const publishedEvent = mockBroker.publish.mock.calls[0][1];
            expect(publishedEvent.properties?.correlationId).toBe('corr-123');
            expect(publishedEvent.properties?.contentType).toBe('application/json');
        });

        it('should include error stack trace when available', async () => {
            const dlqConfig = {
                queue: 'test.dlq',
                exchange: {
                    name: 'dlq.exchange',
                    type: 'direct' as const,
                    options: { durable: true }
                }
            };

            const error = new Error('Test error');

            await handleDLQ(dlqConfig, mockBroker, testEvent, error);

            const publishedEvent = mockBroker.publish.mock.calls[0][1];
            expect(publishedEvent.properties?.headers?.['x-error-stack']).toBeDefined();
            expect(publishedEvent.properties?.headers?.['x-error-stack']).toContain('Error: Test error');
        });

        it('should not send to DLQ when queue is not configured', async () => {
            await handleDLQ(undefined, mockBroker, testEvent);

            expect(mockBroker.publish).not.toHaveBeenCalled();
        });

        it('should not send to DLQ when exchange is not configured', async () => {
            const dlqConfig = {
                queue: 'test.dlq'
            };

            await handleDLQ(dlqConfig as any, mockBroker, testEvent);

            expect(mockBroker.publish).not.toHaveBeenCalled();
        });

        it('should handle missing original queue gracefully', async () => {
            const dlqConfig = {
                queue: 'test.dlq',
                exchange: {
                    name: 'dlq.exchange',
                    type: 'direct' as const,
                    options: { durable: true }
                }
            };

            await handleDLQ(dlqConfig, mockBroker, testEvent);

            const publishedEvent = mockBroker.publish.mock.calls[0][1];
            expect(publishedEvent.properties?.headers?.['x-original-queue']).toBe('');
        });

        it('should handle missing attempts gracefully', async () => {
            const dlqConfig = {
                queue: 'test.dlq',
                exchange: {
                    name: 'dlq.exchange',
                    type: 'direct' as const,
                    options: { durable: true }
                }
            };

            await handleDLQ(dlqConfig, mockBroker, testEvent);

            const publishedEvent = mockBroker.publish.mock.calls[0][1];
            expect(publishedEvent.properties?.headers?.['x-death-count']).toBe(1);
        });

        it('should preserve x-first-death headers from original message', async () => {
            const dlqConfig = {
                queue: 'test.dlq',
                exchange: {
                    name: 'dlq.exchange',
                    type: 'direct' as const,
                    options: { durable: true }
                }
            };

            testEvent.properties = {
                ...testEvent.properties,
                headers: {
                    'x-first-death-exchange': 'original.exchange',
                    'x-first-death-queue': 'original.queue',
                    'x-first-death-routing-key': 'original.key'
                }
            };

            await handleDLQ(dlqConfig, mockBroker, testEvent);

            const publishedEvent = mockBroker.publish.mock.calls[0][1];
            expect(publishedEvent.properties?.headers?.['x-first-death-exchange']).toBe('original.exchange');
            expect(publishedEvent.properties?.headers?.['x-first-death-queue']).toBe('original.queue');
            expect(publishedEvent.properties?.headers?.['x-first-death-routing-key']).toBe('original.key');
        });

        it('should include death timestamp', async () => {
            const dlqConfig = {
                queue: 'test.dlq',
                exchange: {
                    name: 'dlq.exchange',
                    type: 'direct' as const,
                    options: { durable: true }
                }
            };

            const beforeTime = new Date().toISOString();
            await handleDLQ(dlqConfig, mockBroker, testEvent);
            const afterTime = new Date().toISOString();

            const publishedEvent = mockBroker.publish.mock.calls[0][1];
            const deathTime = publishedEvent.properties?.headers?.['x-death-time'];
            
            expect(deathTime).toBeDefined();
            expect(deathTime >= beforeTime).toBe(true);
            expect(deathTime <= afterTime).toBe(true);
        });
    });
});
