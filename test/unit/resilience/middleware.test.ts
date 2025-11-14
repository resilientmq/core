import { applyMiddleware } from '../../../src/resilience/middleware';
import { EventMessage, Middleware } from '../../../src/types';
import { EventConsumeStatus } from '../../../src/types';

describe('Middleware', () => {
    let testEvent: EventMessage;

    beforeEach(() => {
        testEvent = {
            messageId: 'msg-001',
            type: 'test.event',
            payload: { data: 'test' },
            status: EventConsumeStatus.RECEIVED,
            properties: {}
        };
    });

    describe('applyMiddleware', () => {
        it('should execute middleware in sequential order', async () => {
            const executionOrder: number[] = [];

            const middleware1: Middleware = async (ctx, next) => {
                executionOrder.push(1);
                await next();
                executionOrder.push(4);
            };

            const middleware2: Middleware = async (ctx, next) => {
                executionOrder.push(2);
                await next();
                executionOrder.push(3);
            };

            const handler = jest.fn(async () => {
                executionOrder.push(5);
            });

            await applyMiddleware([middleware1, middleware2], testEvent, handler);

            expect(executionOrder).toEqual([1, 2, 5, 3, 4]);
        });

        it('should call handler after all middleware', async () => {
            const middleware1: Middleware = async (ctx, next) => {
                await next();
            };

            const middleware2: Middleware = async (ctx, next) => {
                await next();
            };

            const handler = jest.fn();

            await applyMiddleware([middleware1, middleware2], testEvent, handler);

            expect(handler).toHaveBeenCalled();
        });

        it('should propagate context through middleware chain', async () => {
            const contexts: EventMessage[] = [];

            const middleware1: Middleware = async (ctx, next) => {
                contexts.push(ctx);
                await next();
            };

            const middleware2: Middleware = async (ctx, next) => {
                contexts.push(ctx);
                await next();
            };

            const handler = jest.fn();

            await applyMiddleware([middleware1, middleware2], testEvent, handler);

            expect(contexts).toHaveLength(2);
            expect(contexts[0]).toBe(testEvent);
            expect(contexts[1]).toBe(testEvent);
        });

        it('should allow middleware to modify context', async () => {
            const middleware1: Middleware = async (ctx, next) => {
                (ctx as any).modified = true;
                await next();
            };

            const middleware2: Middleware = async (ctx, next) => {
                (ctx as any).count = 42;
                await next();
            };

            const handler = jest.fn();

            await applyMiddleware([middleware1, middleware2], testEvent, handler);

            expect((testEvent as any).modified).toBe(true);
            expect((testEvent as any).count).toBe(42);
        });

        it('should stop execution when middleware does not call next', async () => {
            const middleware1: Middleware = async (ctx, next) => {
                // Intentionally not calling next()
            };

            const middleware2: Middleware = jest.fn(async (ctx, next) => {
                await next();
            });

            const handler = jest.fn();

            await applyMiddleware([middleware1, middleware2], testEvent, handler);

            expect(middleware2).not.toHaveBeenCalled();
            expect(handler).not.toHaveBeenCalled();
        });

        it('should handle errors thrown in middleware', async () => {
            const middleware1: Middleware = async (ctx, next) => {
                throw new Error('Middleware error');
            };

            const handler = jest.fn();

            await expect(
                applyMiddleware([middleware1], testEvent, handler)
            ).rejects.toThrow('Middleware error');

            expect(handler).not.toHaveBeenCalled();
        });

        it('should propagate errors from handler through middleware', async () => {
            const middleware1: Middleware = async (ctx, next) => {
                try {
                    await next();
                } catch (error) {
                    throw new Error('Caught in middleware: ' + (error as Error).message);
                }
            };

            const handler = jest.fn(async () => {
                throw new Error('Handler error');
            });

            await expect(
                applyMiddleware([middleware1], testEvent, handler)
            ).rejects.toThrow('Caught in middleware: Handler error');
        });

        it('should allow middleware to catch and handle errors', async () => {
            let errorCaught = false;

            const middleware1: Middleware = async (ctx, next) => {
                try {
                    await next();
                } catch (error) {
                    errorCaught = true;
                    // Error is caught and not re-thrown
                }
            };

            const handler = jest.fn(async () => {
                throw new Error('Handler error');
            });

            await applyMiddleware([middleware1], testEvent, handler);

            expect(errorCaught).toBe(true);
        });

        it('should work with empty middleware array', async () => {
            const handler = jest.fn();

            await applyMiddleware([], testEvent, handler);

            expect(handler).toHaveBeenCalled();
        });

        it('should work with single middleware', async () => {
            const middleware1: Middleware = async (ctx, next) => {
                (ctx as any).processed = true;
                await next();
            };

            const handler = jest.fn();

            await applyMiddleware([middleware1], testEvent, handler);

            expect((testEvent as any).processed).toBe(true);
            expect(handler).toHaveBeenCalled();
        });

        it('should allow middleware to execute code after handler', async () => {
            const executionLog: string[] = [];

            const middleware1: Middleware = async (ctx, next) => {
                executionLog.push('middleware1-before');
                await next();
                executionLog.push('middleware1-after');
            };

            const handler = jest.fn(async () => {
                executionLog.push('handler');
            });

            await applyMiddleware([middleware1], testEvent, handler);

            expect(executionLog).toEqual(['middleware1-before', 'handler', 'middleware1-after']);
        });

        it('should handle async operations in middleware', async () => {
            const middleware1: Middleware = async (ctx, next) => {
                await new Promise(resolve => setTimeout(resolve, 10));
                (ctx as any).delayed = true;
                await next();
            };

            const handler = jest.fn();

            await applyMiddleware([middleware1], testEvent, handler);

            expect((testEvent as any).delayed).toBe(true);
            expect(handler).toHaveBeenCalled();
        });

        it('should maintain correct execution order with multiple async middleware', async () => {
            const executionOrder: string[] = [];

            const middleware1: Middleware = async (ctx, next) => {
                executionOrder.push('m1-start');
                await new Promise(resolve => setTimeout(resolve, 20));
                await next();
                executionOrder.push('m1-end');
            };

            const middleware2: Middleware = async (ctx, next) => {
                executionOrder.push('m2-start');
                await new Promise(resolve => setTimeout(resolve, 10));
                await next();
                executionOrder.push('m2-end');
            };

            const handler = jest.fn(async () => {
                executionOrder.push('handler');
            });

            await applyMiddleware([middleware1, middleware2], testEvent, handler);

            expect(executionOrder).toEqual(['m1-start', 'm2-start', 'handler', 'm2-end', 'm1-end']);
        });

        it('should allow middleware to add metadata to context', async () => {
            const middleware1: Middleware = async (ctx, next) => {
                if (!ctx.properties) ctx.properties = {};
                if (!ctx.properties.headers) ctx.properties.headers = {};
                ctx.properties.headers['x-processed-by'] = 'middleware1';
                await next();
            };

            const middleware2: Middleware = async (ctx, next) => {
                if (!ctx.properties) ctx.properties = {};
                if (!ctx.properties.headers) ctx.properties.headers = {};
                ctx.properties.headers['x-timestamp'] = Date.now();
                await next();
            };

            const handler = jest.fn();

            await applyMiddleware([middleware1, middleware2], testEvent, handler);

            expect(testEvent.properties?.headers?.['x-processed-by']).toBe('middleware1');
            expect(testEvent.properties?.headers?.['x-timestamp']).toBeDefined();
        });

        it('should handle middleware that conditionally calls next', async () => {
            const middleware1: Middleware = async (ctx, next) => {
                if (ctx.type === 'test.event') {
                    await next();
                }
            };

            const handler = jest.fn();

            await applyMiddleware([middleware1], testEvent, handler);

            expect(handler).toHaveBeenCalled();
        });

        it('should not call handler when middleware condition fails', async () => {
            const middleware1: Middleware = async (ctx, next) => {
                if (ctx.type === 'other.event') {
                    await next();
                }
            };

            const handler = jest.fn();

            await applyMiddleware([middleware1], testEvent, handler);

            expect(handler).not.toHaveBeenCalled();
        });
    });
});
