/**
 * Preservation Property Tests — Consumer Graceful Shutdown
 *
 * Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6
 *
 * These tests MUST PASS on unfixed code — passing confirms the baseline behavior
 * that must be preserved after the fix.
 *
 * Preservation scope: all inputs where `isBugCondition` returns `false`
 *   isBugCondition(X) = X.shutdownTriggered AND (X.processingCount > 0 OR X.pendingAcks > 0 OR X.eventsInRetryState > 0)
 *
 * So preservation covers:
 *   - Normal processing (no shutdown triggered)
 *   - Shutdown with NO in-flight events (processingCount=0, pendingAcks=0, eventsInRetryState=0)
 *
 * Property 2: For all inputs where isBugCondition returns false, the behavior is
 *             identical to the original (no regressions introduced by the fix).
 */

import { ResilientEventConsumeProcessor } from '../../../src/resilience/resilient-event-consume-processor';
import { ResilientConsumer } from '../../../src/resilience/resilient-consumer';
import { EventConsumeStatus } from '../../../src/types/enum/event-consume-status';
import { EventMessage, MessageQueue, RabbitMQResilientProcessorConfig, ResilientConsumerConfig } from '../../../src/types';
import { EventStoreMock } from '../../utils/event-store-mock';

// ─── Mock amqplib and AmqpQueue ──────────────────────────────────────────────

jest.mock('amqplib', () => ({
    connect: jest.fn().mockResolvedValue({
        createChannel: jest.fn().mockResolvedValue({
            prefetch: jest.fn(),
            assertQueue: jest.fn().mockResolvedValue({}),
            assertExchange: jest.fn().mockResolvedValue({}),
            bindQueue: jest.fn().mockResolvedValue({}),
            consume: jest.fn().mockResolvedValue({ consumerTag: 'tag' }),
            checkQueue: jest.fn().mockResolvedValue({ messageCount: 0 }),
            close: jest.fn().mockResolvedValue(undefined),
            on: jest.fn(),
        }),
        close: jest.fn().mockResolvedValue(undefined),
        on: jest.fn(),
        removeAllListeners: jest.fn(),
    }),
}));

jest.mock('../../../src/broker/amqp-queue');

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Builds a minimal mock broker for processor tests. */
function buildMockBroker(): jest.Mocked<MessageQueue> {
    return {
        connect: jest.fn(),
        publish: jest.fn().mockResolvedValue(undefined),
        consume: jest.fn(),
        disconnect: jest.fn(),
        close: jest.fn(),
    } as any;
}

/** Builds a minimal ResilientConsumerConfig with a mock store. */
function buildConsumerConfig(
    store: EventStoreMock,
    handler: (event: EventMessage) => Promise<void>,
    overrides: Partial<ResilientConsumerConfig> = {}
): ResilientConsumerConfig {
    return {
        connection: 'amqp://localhost:5672',
        consumeQueue: { queue: 'test.queue', options: { durable: true } },
        eventsToProcess: [{ type: 'order.created', handler }],
        store,
        prefetch: 1,
        maxUptimeMs: 0,
        heartbeatIntervalMs: 999_999,
        exitIfIdle: false,
        ...overrides,
    };
}

/** Builds a minimal RabbitMQResilientProcessorConfig. */
function buildProcessorConfig(
    store: EventStoreMock,
    broker: jest.Mocked<MessageQueue>,
    handler: (event: EventMessage) => Promise<void>,
    overrides: Partial<RabbitMQResilientProcessorConfig> = {}
): RabbitMQResilientProcessorConfig {
    return {
        connection: 'amqp://localhost:5672',
        broker,
        store,
        consumeQueue: { queue: 'test.queue' },
        eventsToProcess: [{ type: 'order.created', handler }],
        ...overrides,
    };
}

/** Generates a random alphanumeric string of given length. */
function randomId(length = 12): string {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    return Array.from({ length }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

/** Generates a random EventMessage with the given type. */
function randomEvent(type = 'order.created', retryCount?: number): EventMessage {
    const event: EventMessage = {
        messageId: `evt-${randomId()}`,
        type,
        payload: { id: randomId(), value: Math.floor(Math.random() * 1000) },
    };
    if (retryCount !== undefined && retryCount > 0) {
        event.properties = { headers: { 'x-retry-count': retryCount } };
    }
    return event;
}

// ─── Setup mock AmqpQueue for consumer tests ─────────────────────────────────

function setupAmqpQueueMock(consumeCallback?: (cb: (event: EventMessage) => Promise<void>) => void) {
    const AmqpQueueMock = require('../../../src/broker/amqp-queue').AmqpQueue;
    AmqpQueueMock.mockImplementation(() => ({
        connect: jest.fn().mockResolvedValue(undefined),
        consume: jest.fn().mockImplementation(async (_queue: string, cb: (event: EventMessage) => Promise<void>) => {
            if (consumeCallback) consumeCallback(cb);
        }),
        cancelAllConsumers: jest.fn().mockResolvedValue(undefined),
        disconnect: jest.fn().mockResolvedValue(undefined),
        closed: false,
        channel: {
            assertQueue: jest.fn().mockResolvedValue({ queue: 'test.queue' }),
            assertExchange: jest.fn().mockResolvedValue({}),
            bindQueue: jest.fn().mockResolvedValue({}),
            checkQueue: jest.fn().mockResolvedValue({ messageCount: 0 }),
            ack: jest.fn(),
            nack: jest.fn(),
        },
        connection: { on: jest.fn() },
    }));
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Preservation Property Tests — Consumer Graceful Shutdown', () => {
    let store: EventStoreMock;
    let broker: jest.Mocked<MessageQueue>;

    beforeAll(() => {
        // Increase max listeners to avoid warnings from multiple SIGTERM/SIGINT registrations
        // in PBT loops that create many ResilientConsumer instances
        process.setMaxListeners(100);
    });

    afterAll(() => {
        process.setMaxListeners(10);
    });

    beforeEach(() => {
        store = new EventStoreMock();
        broker = buildMockBroker();
        jest.clearAllMocks();
    });

    afterEach(() => {
        store.clear();
    });

    // ─── Observation 1: Normal successful processing ──────────────────────────
    /**
     * Validates: Requirement 3.1
     *
     * Property: For any event processed successfully (handler resolves),
     * the event status in the store MUST be DONE.
     *
     * isBugCondition = false (no shutdown triggered, normal processing)
     */
    describe('Observation 1 — Normal successful processing → DONE', () => {
        it('should update event status to DONE after successful handler execution', async () => {
            const handler = jest.fn().mockResolvedValue(undefined);
            const config = buildProcessorConfig(store, broker, handler);
            const processor = new ResilientEventConsumeProcessor(config);

            const event = randomEvent();
            await processor.process(event);

            const stored = await store.getEvent(event);
            expect(stored?.status).toBe(EventConsumeStatus.DONE);
            expect(handler).toHaveBeenCalledWith(event);
        });

        /**
         * Property-based: run many random events through successful processing,
         * all must end in DONE.
         *
         * Validates: Requirement 3.1
         */
        it('PBT — for any successful event, status is always DONE (50 random inputs)', async () => {
            const handler = jest.fn().mockResolvedValue(undefined);
            const config = buildProcessorConfig(store, broker, handler);
            const processor = new ResilientEventConsumeProcessor(config);

            // Generate 50 random events and process each
            for (let i = 0; i < 50; i++) {
                store.clear();
                const event = randomEvent();
                await processor.process(event);

                const stored = await store.getEvent(event);
                expect(stored?.status).toBe(EventConsumeStatus.DONE);
            }
        });

        it('should work without store configured — handler still called', async () => {
            const handler = jest.fn().mockResolvedValue(undefined);
            const config = buildProcessorConfig(store, broker, handler, { store: undefined });
            const processor = new ResilientEventConsumeProcessor(config);

            const event = randomEvent();
            await processor.process(event);

            expect(handler).toHaveBeenCalledWith(event);
        });
    });

    // ─── Observation 2: Handler fails with retries available → RETRY ──────────
    /**
     * Validates: Requirement 3.2
     *
     * Property: For any event where the handler fails and retries are available
     * (retryCount < maxAttempts), the event status MUST be RETRY and the event
     * MUST be published to the retry queue with x-retry-count incremented.
     *
     * isBugCondition = false (no shutdown triggered)
     */
    describe('Observation 2 — Handler fails with retries available → RETRY + retry queue', () => {
        it('should update status to RETRY and publish to retry queue on handler failure', async () => {
            const handler = jest.fn().mockRejectedValue(new Error('transient error'));
            const config = buildProcessorConfig(store, broker, handler, {
                retryQueue: { queue: 'retry.queue', maxAttempts: 3 },
            });
            const processor = new ResilientEventConsumeProcessor(config);

            const event = randomEvent();
            await processor.process(event);

            const stored = await store.getEvent(event);
            expect(stored?.status).toBe(EventConsumeStatus.RETRY);

            expect(broker.publish).toHaveBeenCalledWith(
                'retry.queue',
                expect.objectContaining({
                    messageId: event.messageId,
                    properties: expect.objectContaining({
                        headers: expect.objectContaining({ 'x-retry-count': 1 }),
                    }),
                }),
                undefined
            );
        });

        it('should increment x-retry-count on each retry attempt', async () => {
            const handler = jest.fn().mockRejectedValue(new Error('transient error'));
            const config = buildProcessorConfig(store, broker, handler, {
                retryQueue: { queue: 'retry.queue', maxAttempts: 5 },
            });
            const processor = new ResilientEventConsumeProcessor(config);

            // Simulate retries 0 → 1 → 2 → 3
            for (let retryCount = 0; retryCount < 3; retryCount++) {
                broker.publish.mockClear();
                const event = randomEvent('order.created', retryCount === 0 ? undefined : retryCount);
                await processor.process(event);

                expect(broker.publish).toHaveBeenCalledWith(
                    'retry.queue',
                    expect.objectContaining({
                        properties: expect.objectContaining({
                            headers: expect.objectContaining({ 'x-retry-count': retryCount + 1 }),
                        }),
                    }),
                    undefined
                );
            }
        });

        /**
         * Property-based: for any retryCount in [0, maxAttempts-2], a failing handler
         * always produces RETRY status and publishes with incremented x-retry-count.
         *
         * Validates: Requirement 3.2
         */
        it('PBT — for any retryCount < maxAttempts-1, failing handler always produces RETRY (30 random inputs)', async () => {
            const maxAttempts = 5;
            const handler = jest.fn().mockRejectedValue(new Error('transient error'));
            const config = buildProcessorConfig(store, broker, handler, {
                retryQueue: { queue: 'retry.queue', maxAttempts },
            });
            const processor = new ResilientEventConsumeProcessor(config);

            for (let i = 0; i < 30; i++) {
                store.clear();
                broker.publish.mockClear();

                // retryCount in [0, maxAttempts-2] → still has retries left
                const retryCount = Math.floor(Math.random() * (maxAttempts - 1));
                const event = randomEvent('order.created', retryCount === 0 ? undefined : retryCount);

                await processor.process(event);

                const stored = await store.getEvent(event);
                expect(stored?.status).toBe(EventConsumeStatus.RETRY);

                expect(broker.publish).toHaveBeenCalledWith(
                    'retry.queue',
                    expect.objectContaining({
                        properties: expect.objectContaining({
                            headers: expect.objectContaining({ 'x-retry-count': retryCount + 1 }),
                        }),
                    }),
                    undefined
                );
            }
        });
    });

    // ─── Observation 3: Max retries exceeded → ERROR + DLQ ───────────────────
    /**
     * Validates: Requirement 3.3
     *
     * Property: For any event where retryCount >= maxAttempts, the event status
     * MUST be ERROR and the event MUST be published to the DLQ.
     *
     * isBugCondition = false (no shutdown triggered)
     */
    describe('Observation 3 — Max retries exceeded → ERROR + DLQ', () => {
        it('should update status to ERROR and publish to DLQ when max retries exceeded', async () => {
            const handler = jest.fn().mockRejectedValue(new Error('persistent error'));
            const config = buildProcessorConfig(store, broker, handler, {
                retryQueue: { queue: 'retry.queue', maxAttempts: 3 },
                deadLetterQueue: { queue: 'dlq.queue' },
            });
            const processor = new ResilientEventConsumeProcessor(config);

            // Pre-save event to simulate it was stored in earlier attempts
            const event = randomEvent('order.created', 3); // retryCount = maxAttempts
            await store.saveEvent(event);

            await processor.process(event);

            const stored = await store.getEvent(event);
            expect(stored?.status).toBe(EventConsumeStatus.ERROR);

            expect(broker.publish).toHaveBeenCalledWith(
                'dlq.queue',
                expect.objectContaining({ messageId: event.messageId }),
                undefined
            );
        });

        it('should discard (no publish) when max retries exceeded and no DLQ configured', async () => {
            const handler = jest.fn();
            const config = buildProcessorConfig(store, broker, handler, {
                retryQueue: { queue: 'retry.queue', maxAttempts: 3 },
                // No deadLetterQueue
            });
            const processor = new ResilientEventConsumeProcessor(config);

            const event = randomEvent('order.created', 3);
            await store.saveEvent(event);

            await processor.process(event);

            const stored = await store.getEvent(event);
            expect(stored?.status).toBe(EventConsumeStatus.ERROR);
            expect(broker.publish).not.toHaveBeenCalled();
            expect(handler).not.toHaveBeenCalled(); // hard guard at entry
        });

        /**
         * Property-based: for any retryCount >= maxAttempts, the event always ends in ERROR.
         *
         * Validates: Requirement 3.3
         */
        it('PBT — for any retryCount >= maxAttempts, event always ends in ERROR (30 random inputs)', async () => {
            const maxAttempts = 3;
            const handler = jest.fn().mockRejectedValue(new Error('persistent error'));
            const config = buildProcessorConfig(store, broker, handler, {
                retryQueue: { queue: 'retry.queue', maxAttempts },
                deadLetterQueue: { queue: 'dlq.queue' },
            });
            const processor = new ResilientEventConsumeProcessor(config);

            for (let i = 0; i < 30; i++) {
                store.clear();
                broker.publish.mockClear();

                // retryCount in [maxAttempts, maxAttempts + 10]
                const retryCount = maxAttempts + Math.floor(Math.random() * 10);
                const event = randomEvent('order.created', retryCount);
                await store.saveEvent(event);

                await processor.process(event);

                const stored = await store.getEvent(event);
                expect(stored?.status).toBe(EventConsumeStatus.ERROR);
            }
        });
    });

    // ─── Observation 4: Duplicate event → ignored + ack without reprocessing ──
    /**
     * Validates: Requirement 3.4
     *
     * Property: For any event where messageId already exists in the store with
     * retryCount === 0, the handler MUST NOT be called again (deduplication).
     *
     * isBugCondition = false (no shutdown triggered)
     */
    describe('Observation 4 — Duplicate event (messageId in store, retryCount=0) → ignored', () => {
        it('should skip handler for duplicate event on first attempt', async () => {
            const handler = jest.fn().mockResolvedValue(undefined);
            const config = buildProcessorConfig(store, broker, handler);
            const processor = new ResilientEventConsumeProcessor(config);

            const event = randomEvent();

            // First processing — should succeed
            await processor.process(event);
            expect(handler).toHaveBeenCalledTimes(1);

            // Second processing of same event (retryCount=0) — should be skipped
            handler.mockClear();
            const duplicateEvent = { ...event, properties: { headers: {} } };
            await processor.process(duplicateEvent);

            expect(handler).not.toHaveBeenCalled();
        });

        it('should NOT skip handler for same messageId on retry attempt (retryCount > 0)', async () => {
            const handler = jest.fn().mockResolvedValue(undefined);
            const config = buildProcessorConfig(store, broker, handler);
            const processor = new ResilientEventConsumeProcessor(config);

            const event = randomEvent();

            // First processing
            await processor.process(event);
            expect(handler).toHaveBeenCalledTimes(1);

            // Retry attempt (retryCount=1) — should NOT be skipped
            handler.mockClear();
            const retryEvent = { ...event, properties: { headers: { 'x-retry-count': 1 } } };
            await processor.process(retryEvent);

            expect(handler).toHaveBeenCalledTimes(1);
        });

        /**
         * Property-based: for any set of N random events, processing each twice
         * (with retryCount=0) always results in handler called exactly once per event.
         *
         * Validates: Requirement 3.4
         */
        it('PBT — duplicate events (retryCount=0) are always deduplicated (20 random event sets)', async () => {
            const handler = jest.fn().mockResolvedValue(undefined);
            const config = buildProcessorConfig(store, broker, handler);
            const processor = new ResilientEventConsumeProcessor(config);

            for (let i = 0; i < 20; i++) {
                store.clear();
                handler.mockClear();

                const event = randomEvent();

                // Process twice with retryCount=0
                await processor.process(event);
                await processor.process({ ...event, properties: { headers: {} } });

                // Handler called exactly once (second is deduplicated)
                expect(handler).toHaveBeenCalledTimes(1);
            }
        });
    });

    // ─── Observation 5: Shutdown with no in-flight events → stop() works fine ─
    /**
     * Validates: Requirements 3.5, 3.6
     *
     * Property: When stop() is called with processingCount=0, pendingAcks=0,
     * eventsInRetryState=0 (isBugCondition=false), stop() completes without error.
     *
     * This is the "clean shutdown" case — no events in flight.
     */
    describe('Observation 5 — Shutdown with no in-flight events → stop() completes normally', () => {
        it('should stop cleanly when no events are in flight', async () => {
            setupAmqpQueueMock();

            const consumer = new ResilientConsumer(
                buildConsumerConfig(store, jest.fn().mockResolvedValue(undefined))
            );
            await consumer.start();

            // No events in flight — isBugCondition = false
            expect((consumer as any).processingCount).toBe(0);

            // stop() should complete without error
            await expect(consumer.stop()).resolves.not.toThrow();
        });

        it('should stop cleanly when store has only DONE events (no RETRY)', async () => {
            setupAmqpQueueMock();

            const consumer = new ResilientConsumer(
                buildConsumerConfig(store, jest.fn().mockResolvedValue(undefined))
            );
            await consumer.start();

            // Pre-populate store with DONE events (not in-flight)
            for (let i = 0; i < 5; i++) {
                const event = randomEvent();
                await store.saveEvent(event);
                await store.updateEventStatus(event, EventConsumeStatus.DONE);
            }

            // isBugCondition = false (no RETRY events, no in-flight)
            await expect(consumer.stop()).resolves.not.toThrow();
        });

        it('should stop cleanly when store has only ERROR events (no RETRY)', async () => {
            setupAmqpQueueMock();

            const consumer = new ResilientConsumer(
                buildConsumerConfig(store, jest.fn().mockResolvedValue(undefined))
            );
            await consumer.start();

            // Pre-populate store with ERROR events
            for (let i = 0; i < 3; i++) {
                const event = randomEvent();
                await store.saveEvent(event);
                await store.updateEventStatus(event, EventConsumeStatus.ERROR);
            }

            // isBugCondition = false (no RETRY events, no in-flight)
            await expect(consumer.stop()).resolves.not.toThrow();
        });

        it('should stop cleanly without store configured', async () => {
            setupAmqpQueueMock();

            const consumer = new ResilientConsumer(
                buildConsumerConfig(store, jest.fn().mockResolvedValue(undefined), { store: undefined })
            );
            await consumer.start();

            await expect(consumer.stop()).resolves.not.toThrow();
        });

        /**
         * Property-based: for many random combinations of DONE/ERROR events in the store
         * (no RETRY, no in-flight), stop() always completes without error.
         *
         * Validates: Requirements 3.5, 3.6
         */
        it('PBT — stop() with no in-flight events always completes without error (20 random store states)', async () => {
            const statuses = [EventConsumeStatus.DONE, EventConsumeStatus.ERROR];

            for (let i = 0; i < 20; i++) {
                store.clear();
                jest.clearAllMocks();
                setupAmqpQueueMock();

                const consumer = new ResilientConsumer(
                    buildConsumerConfig(store, jest.fn().mockResolvedValue(undefined))
                );
                await consumer.start();

                // Random number of events (0–10) with random DONE/ERROR statuses
                const eventCount = Math.floor(Math.random() * 10);
                for (let j = 0; j < eventCount; j++) {
                    const event = randomEvent();
                    await store.saveEvent(event);
                    const status = statuses[Math.floor(Math.random() * statuses.length)];
                    await store.updateEventStatus(event, status);
                }

                // processingCount = 0, no RETRY events → isBugCondition = false
                expect((consumer as any).processingCount).toBe(0);

                await expect(consumer.stop()).resolves.not.toThrow();
            }
        });
    });

    // ─── Observation 6: Full end-to-end normal flow via consumer ─────────────
    /**
     * Validates: Requirements 3.1, 3.2, 3.3
     *
     * Property: The full consume callback (as wired by ResilientConsumer) correctly
     * delegates to the processor and produces the expected store state.
     *
     * isBugCondition = false (no shutdown triggered during processing)
     */
    describe('Observation 6 — Full consumer flow (no shutdown) preserves processing behavior', () => {
        it('should process event to DONE via consumer consume callback', async () => {
            let consumeCallback: ((event: EventMessage) => Promise<void>) | null = null;

            setupAmqpQueueMock(cb => { consumeCallback = cb; });

            const handler = jest.fn().mockResolvedValue(undefined);
            const consumer = new ResilientConsumer(
                buildConsumerConfig(store, handler, {
                    retryQueue: { queue: 'retry.queue', maxAttempts: 3 },
                })
            );
            await consumer.start();

            expect(consumeCallback).not.toBeNull();

            const event = randomEvent();
            await consumeCallback!(event);

            const stored = await store.getEvent(event);
            expect(stored?.status).toBe(EventConsumeStatus.DONE);
            expect(handler).toHaveBeenCalledWith(event);
        });

        it('should process event to RETRY via consumer consume callback when handler fails', async () => {
            let consumeCallback: ((event: EventMessage) => Promise<void>) | null = null;

            const AmqpQueueMock = require('../../../src/broker/amqp-queue').AmqpQueue;
            const mockPublish = jest.fn().mockResolvedValue(undefined);
            AmqpQueueMock.mockImplementation(() => ({
                connect: jest.fn().mockResolvedValue(undefined),
                consume: jest.fn().mockImplementation(async (_queue: string, cb: (event: EventMessage) => Promise<void>) => {
                    consumeCallback = cb;
                }),
                cancelAllConsumers: jest.fn().mockResolvedValue(undefined),
                disconnect: jest.fn().mockResolvedValue(undefined),
                closed: false,
                publish: mockPublish,
                channel: {
                    assertQueue: jest.fn().mockResolvedValue({ queue: 'test.queue' }),
                    assertExchange: jest.fn().mockResolvedValue({}),
                    bindQueue: jest.fn().mockResolvedValue({}),
                    checkQueue: jest.fn().mockResolvedValue({ messageCount: 0 }),
                },
                connection: { on: jest.fn() },
            }));

            const handler = jest.fn().mockRejectedValue(new Error('transient error'));
            const consumer = new ResilientConsumer(
                buildConsumerConfig(store, handler, {
                    retryQueue: { queue: 'retry.queue', maxAttempts: 3 },
                })
            );
            await consumer.start();

            expect(consumeCallback).not.toBeNull();

            const event = randomEvent();
            // The processor catches the error internally — consume callback should NOT throw
            await expect(consumeCallback!(event)).resolves.not.toThrow();

            const stored = await store.getEvent(event);
            expect(stored?.status).toBe(EventConsumeStatus.RETRY);
        });

        it('should increment and decrement processingCount correctly during normal processing', async () => {
            let consumeCallback: ((event: EventMessage) => Promise<void>) | null = null;
            let processingCountDuringHandler = -1;

            setupAmqpQueueMock(cb => { consumeCallback = cb; });

            const handler = jest.fn().mockImplementation(async () => {
                processingCountDuringHandler = (consumer as any).processingCount;
            });

            const consumer = new ResilientConsumer(
                buildConsumerConfig(store, handler)
            );
            await consumer.start();

            expect(consumeCallback).not.toBeNull();

            const event = randomEvent();
            await consumeCallback!(event);

            // During handler execution, processingCount should be 1
            expect(processingCountDuringHandler).toBe(1);

            // After processing, processingCount should be back to 0
            expect((consumer as any).processingCount).toBe(0);
        });
    });
});
