import {ResilientEventConsumeProcessor} from '../../../src/resilience/resilient-event-consume-processor';
import {IgnoredEventError} from '../../../src/resilience/ignored-event-error';
import {setLogLevel, setLogSampling, setLogTimestamps} from '../../../src/logger/logger';
import {
    EventConsumeStatus,
    MessageQueue,
    MessageQueueDisconnect,
    RabbitMQResilientProcessorConfig,
    RawMessageDelivery
} from '../../../src/types';
import {EventStoreMock} from '../../utils/event-store-mock';

describe('ResilientEventConsumeProcessor', () => {
    let broker: jest.Mocked<MessageQueue>;
    let store: EventStoreMock;

    beforeEach(() => {
        broker = {
            connect: jest.fn(),
            publish: jest.fn(),
            publishRaw: jest.fn(),
            consume: jest.fn(),
            consumeRaw: jest.fn(),
            onDisconnect: jest.fn((_listener: (disconnect: MessageQueueDisconnect) => void) => () => undefined)
        };
        store = new EventStoreMock();
    });

    it('completes a claimed delivery and exposes stable and ephemeral identities', async () => {
        const handler = jest.fn();
        const processor = createProcessor({broker, store, handler});
        const result = await processor.processRaw(delivery({messageId: 'one'}));
        expect(result).toBe('ack');
        expect(handler).toHaveBeenCalledWith(
            expect.objectContaining({messageId: 'one'}),
            expect.objectContaining({
                attempt: 1,
                serviceId: expect.any(String),
                instanceId: 'instance-a',
                deliveryId: expect.any(String),
                fencingToken: expect.any(String)
            })
        );
        expect((await store.getEvent({messageId: 'one', payload: null}))?.status).toBe(EventConsumeStatus.DONE);
    });

    it('reclaims a persisted PROCESSING state instead of treating it as completed', async () => {
        await store.saveEvent({messageId: 'stale', type: 'known', payload: {}, status: EventConsumeStatus.PROCESSING});
        const handler = jest.fn();
        const processor = createProcessor({broker, store, handler});
        await expect(processor.processRaw(delivery({messageId: 'stale'}))).resolves.toBe('ack');
        expect(handler).toHaveBeenCalledTimes(1);
    });

    it('does not execute a terminal duplicate', async () => {
        await store.saveEvent({messageId: 'done', type: 'known', payload: {}, status: EventConsumeStatus.DONE});
        const handler = jest.fn();
        const processor = createProcessor({broker, store, handler});
        await expect(processor.processRaw(delivery({messageId: 'done'}))).resolves.toBe('ack');
        expect(handler).not.toHaveBeenCalled();
    });

    it('delays a concurrent delivery while another replica owns its lease', async () => {
        let releaseHandler!: () => void;
        const handler = jest.fn(() => new Promise<void>(resolve => { releaseHandler = resolve; }));
        const first = createProcessor({broker, store, handler, instanceId: 'first'});
        const second = createProcessor({broker, store, handler: jest.fn(), instanceId: 'second'});
        const active = first.processRaw(delivery({messageId: 'leased'}));
        await new Promise(resolve => setImmediate(resolve));
        await expect(second.processRaw(delivery({messageId: 'leased'}))).resolves.toBe('requeue');
        releaseHandler();
        await expect(active).resolves.toBe('ack');
    });

    it('does not consume a RabbitMQ retry attempt while the inbox store is unavailable', async () => {
        jest.spyOn(store, 'claimConsumeEvent').mockRejectedValueOnce(new Error('store unavailable'));
        const processor = createProcessor({broker, store, handler: jest.fn()});
        await expect(processor.processRaw(delivery({messageId: 'store-down'}))).rejects.toThrow('store unavailable');
        expect(broker.publishRaw).not.toHaveBeenCalled();
    });

    it('uses RabbitMQ x-death from the main queue as the delivery attempt', () => {
        const processor = createProcessor({broker, store, handler: jest.fn()});
        expect(processor.getDeliveryAttempt(delivery({
            headers: {'x-death': [{queue: 'main', reason: 'rejected', count: 7}]}
        }))).toBe(8);
    });

    it('uses quorum delivery counters without application-owned retry headers', () => {
        const processor = createProcessor({broker, store, handler: jest.fn()});
        expect(processor.getDeliveryAttempt(delivery({headers: {'x-delivery-count': 4}}))).toBe(5);
        expect(processor.getDeliveryAttempt(delivery({headers: {'x-acquired-count': 6}}))).toBe(7);
    });

    it('does not count a connection redelivery as a business retry', () => {
        const processor = createProcessor({broker, store, handler: jest.fn()});
        expect(processor.getDeliveryAttempt(delivery({redelivered: true}))).toBe(1);
    });

    it('rejects a failed non-final attempt so RabbitMQ owns retry routing', async () => {
        const processor = createProcessor({broker, store, handler: jest.fn().mockRejectedValue(new Error('boom'))});
        await expect(processor.processRaw(delivery({messageId: 'retry'}))).resolves.toBe('reject');
        expect(broker.publish).not.toHaveBeenCalled();
        expect(broker.publishRaw).not.toHaveBeenCalled();
        expect((await store.getEvent({messageId: 'retry', payload: null}))?.status).toBe(EventConsumeStatus.RETRY);
    });

    it('completes an explicitly ignored business event without retrying it', async () => {
        const processor = createProcessor({
            broker,
            store,
            handler: jest.fn().mockRejectedValue(new IgnoredEventError('not applicable'))
        });
        await expect(processor.processRaw(delivery({messageId: 'ignored'}))).resolves.toBe('ack');
        expect((await store.getEvent({messageId: 'ignored', payload: null}))?.status).toBe(EventConsumeStatus.DONE);
    });

    it('requeues when a fenced completion loses ownership', async () => {
        jest.spyOn(store, 'transitionConsumeEvent').mockResolvedValueOnce(false);
        const onSuccess = jest.fn();
        const processor = createProcessor({broker, store, handler: jest.fn(), events: {onSuccess}});
        await expect(processor.processRaw(delivery({messageId: 'lost-fence'}))).resolves.toBe('requeue');
        expect(onSuccess).not.toHaveBeenCalled();
    });

    it('does not let a success hook failure change a durable completion', async () => {
        const processor = createProcessor({
            broker,
            store,
            handler: jest.fn(),
            events: {onSuccess: () => { throw new Error('observer failed'); }}
        });
        await expect(processor.processRaw(delivery({messageId: 'hook'}))).resolves.toBe('ack');
        expect((await store.getEvent({messageId: 'hook', payload: null}))?.status).toBe(EventConsumeStatus.DONE);
    });

    it('publishes the final failure to DLQ before acknowledging the original', async () => {
        const processor = createProcessor({broker, store, handler: jest.fn().mockRejectedValue(new Error('boom'))});
        const result = await processor.processRaw(delivery({
            messageId: 'dead',
            headers: {'x-death': [{queue: 'main', reason: 'rejected', count: 2}]}
        }));
        expect(result).toBe('ack');
        expect(broker.publishRaw).toHaveBeenCalledWith(
            'dead',
            expect.any(Buffer),
            expect.objectContaining({
                headers: expect.objectContaining({
                    'x-resilientmq-attempt': 3,
                    'x-resilientmq-original-queue': 'main'
                })
            }),
            expect.anything()
        );
        expect((await store.getEvent({messageId: 'dead', payload: null}))?.status).toBe(EventConsumeStatus.ERROR);
    });

    it('never acknowledges when the final DLQ publication is not confirmed', async () => {
        broker.publishRaw.mockRejectedValue(new Error('confirm unavailable'));
        const processor = createProcessor({broker, store, handler: jest.fn().mockRejectedValue(new Error('boom'))});
        const result = await processor.processRaw(delivery({
            messageId: 'safe',
            headers: {'x-death': [{queue: 'main', reason: 'rejected', count: 2}]}
        }));
        expect(result).toBe('reject');
        expect((await store.getEvent({messageId: 'safe', payload: null}))?.status).toBe(EventConsumeStatus.PROCESSING);
    });

    it('requeues after confirmed DLQ publication when the terminal fence cannot be persisted', async () => {
        jest.spyOn(store, 'transitionConsumeEvent').mockResolvedValueOnce(false);
        const processor = createProcessor({broker, store, handler: jest.fn().mockRejectedValue(new Error('boom'))});
        const result = await processor.processRaw(delivery({
            messageId: 'terminal-fence',
            headers: {'x-death': [{queue: 'main', reason: 'rejected', count: 2}]}
        }));
        expect(result).toBe('requeue');
        expect(broker.publishRaw).toHaveBeenCalledTimes(1);
        expect((await store.getEvent({messageId: 'terminal-fence', payload: null}))?.status)
            .toBe(EventConsumeStatus.PROCESSING);
    });

    it('bounds malformed JSON with the same RabbitMQ attempt headers', async () => {
        const processor = createProcessor({broker, store, handler: jest.fn()});
        const malformed = delivery({
            messageId: 'poison',
            content: Buffer.from('{broken'),
            headers: {'x-death': [{queue: 'main', reason: 'rejected', count: 2}]}
        });
        await expect(processor.processRaw(malformed)).resolves.toBe('ack');
        expect(broker.publishRaw).toHaveBeenCalledWith('dead', malformed.content, expect.anything(), expect.anything());
        expect((await store.getEvent({messageId: 'poison', payload: null}))?.status).toBe(EventConsumeStatus.ERROR);
    });

    it('rejects malformed JSON before its final attempt', async () => {
        const processor = createProcessor({broker, store, handler: jest.fn()});
        await expect(processor.processRaw(delivery({content: Buffer.from('{broken')}))).resolves.toBe('reject');
        expect(broker.publishRaw).not.toHaveBeenCalled();
    });

    it('acknowledges ignored unknown events without touching the store', async () => {
        const processor = createProcessor({broker, store, handler: jest.fn(), ignoreUnknownEvents: true});
        await expect(processor.processRaw(delivery({type: 'unknown'}))).resolves.toBe('ack');
        expect(store.getCallCount('claimConsumeEvent')).toBe(0);
    });

    it('marks accepted unknown events as completed when ignoring is disabled', async () => {
        const processor = createProcessor({broker, store, handler: jest.fn(), ignoreUnknownEvents: false});
        await expect(processor.processRaw(delivery({messageId: 'unknown', type: 'other'}))).resolves.toBe('ack');
        expect((await store.getEvent({messageId: 'unknown', payload: null}))?.status).toBe(EventConsumeStatus.DONE);
    });

    it('cooperatively aborts and retries timed-out handlers without releasing their lease', async () => {
        const handler = jest.fn((_event: unknown, context: {signal: AbortSignal}) => new Promise<void>(resolve => {
            context.signal.addEventListener('abort', () => resolve());
        }));
        const processor = createProcessor({
            broker,
            store,
            handler,
            processingTimeoutMs: 5,
            processingLeaseMs: 50
        });
        await expect(processor.processRaw(delivery({messageId: 'timeout'}))).resolves.toBe('reject');
        expect((await store.getEvent({messageId: 'timeout', payload: null}))?.status).toBe(EventConsumeStatus.PROCESSING);
    });

    it('requeues a shutdown abort without consuming a business attempt', async () => {
        const handler = jest.fn((_event: unknown, context: {signal: AbortSignal}) => new Promise<void>(resolve => {
            context.signal.addEventListener('abort', () => resolve());
        }));
        const processor = createProcessor({broker, store, handler});
        const processing = processor.processRaw(delivery({messageId: 'shutdown'}));
        await new Promise(resolve => setImmediate(resolve));
        processor.abortActive();
        await expect(processing).resolves.toBe('requeue');
    });

    describe('consumer lifecycle logging', () => {
        let consoleError: jest.SpyInstance;
        let consoleInfo: jest.SpyInstance;
        let consoleLog: jest.SpyInstance;

        beforeEach(() => {
            consoleError = jest.spyOn(console, 'error').mockImplementation();
            consoleInfo = jest.spyOn(console, 'info').mockImplementation();
            consoleLog = jest.spyOn(console, 'log').mockImplementation();
            setLogTimestamps(false);
            setLogSampling({error: 1, warn: 1, info: 1, debug: 1});
            setLogLevel('debug');
        });

        afterEach(() => {
            setLogLevel('none');
            setLogTimestamps(true);
            jest.restoreAllMocks();
        });

        it('logs event consumption and durable completion at info level', async () => {
            const processor = createProcessor({broker, store, handler: jest.fn()});

            await expect(processor.processRaw(delivery({messageId: 'logged-success'}))).resolves.toBe('ack');

            expect(consoleInfo).toHaveBeenCalledWith(
                '[Consumer] Consuming event message_id=logged-success event_type=known attempt=1'
            );
            expect(consoleInfo).toHaveBeenCalledWith(expect.stringMatching(
                /^\[Consumer] Event processed successfully message_id=logged-success event_type=known attempt=1 duration_ms=\d+$/
            ));
            expect(consoleError).not.toHaveBeenCalled();
        });

        it('does not log successful processing after losing completion fencing', async () => {
            jest.spyOn(store, 'transitionConsumeEvent').mockResolvedValueOnce(false);
            const processor = createProcessor({broker, store, handler: jest.fn()});

            await expect(processor.processRaw(delivery({messageId: 'uncommitted-success'})))
                .resolves.toBe('requeue');

            expect(consoleInfo.mock.calls.some(call => String(call[0]).includes('Event processed successfully')))
                .toBe(false);
            expect(consoleLog).toHaveBeenCalledWith(
                '[Consumer] Completion lost fencing ownership; requeuing message_id=uncommitted-success event_type=known attempt=1'
            );
        });

        it('logs retry routing and failure details at info level', async () => {
            const processor = createProcessor({
                broker,
                store,
                handler: jest.fn().mockRejectedValue(new Error('temporary failure'))
            });

            await expect(processor.processRaw(delivery({messageId: 'logged-retry'}))).resolves.toBe('reject');

            expect(consoleInfo).toHaveBeenCalledWith(
                '[Consumer] Event scheduled for retry message_id=logged-retry event_type=known attempt=1 next_attempt=2 error_name=Error error_message="temporary failure"'
            );
            expect(consoleError).not.toHaveBeenCalled();
        });

        it('does not log a scheduled business retry after losing retry fencing', async () => {
            jest.spyOn(store, 'transitionConsumeEvent').mockResolvedValueOnce(false);
            const processor = createProcessor({
                broker,
                store,
                handler: jest.fn().mockRejectedValue(new Error('temporary failure'))
            });

            await expect(processor.processRaw(delivery({messageId: 'uncommitted-retry'})))
                .resolves.toBe('requeue');

            expect(consoleInfo.mock.calls.some(call => String(call[0]).includes('Event scheduled for retry')))
                .toBe(false);
            expect(consoleLog).toHaveBeenCalledWith(
                '[Consumer] Retry transition lost fencing ownership; requeuing message_id=uncommitted-retry event_type=known attempt=1'
            );
        });

        it('logs a confirmed and durably recorded dead-letter outcome at error level', async () => {
            const failure = new Error('permanent failure');
            const processor = createProcessor({
                broker,
                store,
                handler: jest.fn().mockRejectedValue(failure)
            });

            await expect(processor.processRaw(delivery({
                messageId: 'logged-dead',
                headers: {'x-death': [{queue: 'main', reason: 'rejected', count: 2}]}
            }))).resolves.toBe('ack');

            expect(consoleError).toHaveBeenCalledWith(
                '[Consumer] Event sent to dead-letter queue message_id=logged-dead event_type=known attempt=3 queue=dead error_name=Error error_message="permanent failure"',
                failure
            );
        });

        it('does not report dead-letter success when its publication is unconfirmed', async () => {
            broker.publishRaw.mockRejectedValue(new Error('confirm unavailable'));
            const processor = createProcessor({
                broker,
                store,
                handler: jest.fn().mockRejectedValue(new Error('permanent failure'))
            });

            await expect(processor.processRaw(delivery({
                messageId: 'unconfirmed-dead',
                headers: {'x-death': [{queue: 'main', reason: 'rejected', count: 2}]}
            }))).resolves.toBe('reject');

            expect(consoleError).toHaveBeenCalledWith(
                '[Consumer] Failed to confirm dead-letter publication message_id=unconfirmed-dead event_type=known attempt=3 queue=dead',
                expect.any(Error)
            );
            expect(consoleError.mock.calls.some(call => String(call[0]).includes('Event sent to dead-letter queue')))
                .toBe(false);
        });

        it('does not report dead-letter success when its terminal transition loses fencing', async () => {
            jest.spyOn(store, 'transitionConsumeEvent').mockResolvedValueOnce(false);
            const processor = createProcessor({
                broker,
                store,
                handler: jest.fn().mockRejectedValue(new Error('permanent failure'))
            });

            await expect(processor.processRaw(delivery({
                messageId: 'uncommitted-dead',
                headers: {'x-death': [{queue: 'main', reason: 'rejected', count: 2}]}
            }))).resolves.toBe('requeue');

            expect(broker.publishRaw).toHaveBeenCalledTimes(1);
            expect(consoleError.mock.calls.some(call => String(call[0]).includes('Event sent to dead-letter queue')))
                .toBe(false);
            expect(consoleLog).toHaveBeenCalledWith(
                '[Consumer] Terminal transition lost fencing ownership; requeuing message_id=uncommitted-dead event_type=known attempt=3'
            );
        });

        it('logs malformed deliveries and their retry at info level', async () => {
            const processor = createProcessor({broker, store, handler: jest.fn()});

            await expect(processor.processRaw(delivery({
                messageId: 'malformed-log',
                content: Buffer.from('{broken')
            }))).resolves.toBe('reject');

            expect(consoleInfo).toHaveBeenCalledWith(
                '[Consumer] Consuming event message_id=malformed-log event_type=known attempt=1'
            );
            expect(consoleInfo).toHaveBeenCalledWith(expect.stringContaining(
                '[Consumer] Event scheduled for retry message_id=malformed-log event_type=known attempt=1 next_attempt=2 error_name=SyntaxError'
            ));
        });

        it('keeps duplicate and ignored-event diagnostics at debug level', async () => {
            await store.saveEvent({
                messageId: 'logged-duplicate',
                type: 'known',
                payload: {},
                status: EventConsumeStatus.DONE
            });
            const processor = createProcessor({broker, store, handler: jest.fn()});

            await expect(processor.processRaw(delivery({messageId: 'logged-duplicate'}))).resolves.toBe('ack');
            await expect(processor.processRaw(delivery({
                messageId: 'logged-unknown',
                type: 'unknown'
            }))).resolves.toBe('ack');

            expect(consoleLog).toHaveBeenCalledWith(
                '[Consumer] Acknowledging completed duplicate message_id=logged-duplicate event_type=known attempt=1'
            );
            expect(consoleLog).toHaveBeenCalledWith(
                '[Consumer] Ignored unknown event message_id=logged-unknown event_type=unknown attempt=1'
            );
        });

        it('suppresses diagnostic lifecycle logs at info level', async () => {
            setLogLevel('info');
            await store.saveEvent({
                messageId: 'quiet-duplicate',
                type: 'known',
                payload: {},
                status: EventConsumeStatus.DONE
            });
            const processor = createProcessor({broker, store, handler: jest.fn()});

            await expect(processor.processRaw(delivery({messageId: 'quiet-duplicate'}))).resolves.toBe('ack');

            expect(consoleInfo).toHaveBeenCalledWith(
                '[Consumer] Consuming event message_id=quiet-duplicate event_type=known attempt=1'
            );
            expect(consoleLog).not.toHaveBeenCalled();
        });
    });
});

function createProcessor(overrides: {
    broker: MessageQueue;
    store?: EventStoreMock;
    handler: jest.Mock;
    instanceId?: string;
    ignoreUnknownEvents?: boolean;
    processingTimeoutMs?: number;
    processingLeaseMs?: number;
    events?: RabbitMQResilientProcessorConfig['events'];
}): ResilientEventConsumeProcessor {
    const config: RabbitMQResilientProcessorConfig = {
        connection: 'amqp://localhost',
        serviceId: 'orders-service',
        resolvedServiceId: 'stable-service-hash',
        instanceId: overrides.instanceId ?? 'instance-a',
        consumeQueue: {queue: 'main'},
        retryQueue: {queue: 'retry', ttlMs: 10, maxAttempts: 3},
        deadLetterQueue: {queue: 'dead'},
        eventsToProcess: [{type: 'known', handler: overrides.handler}],
        broker: overrides.broker,
        store: overrides.store,
        ignoreUnknownEvents: overrides.ignoreUnknownEvents,
        processingTimeoutMs: overrides.processingTimeoutMs,
        processingLeaseMs: overrides.processingLeaseMs,
        events: overrides.events
    };
    return new ResilientEventConsumeProcessor(config);
}

function delivery(overrides: {
    messageId?: string;
    type?: string;
    content?: Buffer;
    headers?: Record<string, unknown>;
    redelivered?: boolean;
} = {}): RawMessageDelivery {
    return {
        content: overrides.content ?? Buffer.from(JSON.stringify({value: 1})),
        properties: {
            messageId: overrides.messageId ?? 'message',
            type: overrides.type ?? 'known',
            headers: overrides.headers ?? {}
        },
        exchange: '',
        routingKey: 'main',
        redelivered: overrides.redelivered ?? false
    };
}
