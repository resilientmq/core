/**
 * Bug Condition Exploration Test — Consumer Graceful Shutdown
 *
 * Validates: Requirements 1.1, 1.2, 1.3, 1.4
 *
 * These tests MUST FAIL on unfixed code — failure confirms the bug exists.
 * DO NOT fix the code or the test when it fails.
 *
 * Bug Condition: isBugCondition(X) returns true when:
 *   X.shutdownTriggered = true AND
 *   (X.processingCount > 0 OR X.pendingAcks > 0 OR X.eventsInRetryState > 0)
 *
 * Expected Behavior Properties (design.md):
 *   Property 1: stop() SHALL wait for all handlers to complete and all acks/nacks to be sent
 *               before closing the AMQP connection, and SHALL mark all RETRY events as ERROR.
 *   Validates: Requirements 2.1, 2.2, 2.3, 2.4
 */

import { ResilientConsumer } from '../../../src/resilience/resilient-consumer';
import { EventConsumeStatus } from '../../../src/types/enum/event-consume-status';
import { EventMessage, ResilientConsumerConfig } from '../../../src/types';
import { EventStoreMock } from '../../utils/event-store-mock';

// ─── Helpers ────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/** Builds a minimal ResilientConsumerConfig with a mock store. */
function buildConfig(
    store: EventStoreMock,
    handler: (event: EventMessage) => Promise<void>
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
    };
}

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

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Bug Condition Exploration — Consumer Graceful Shutdown', () => {
    let store: EventStoreMock;
    const AmqpQueueMock = require('../../../src/broker/amqp-queue').AmqpQueue;

    beforeEach(() => {
        store = new EventStoreMock();
        jest.clearAllMocks();
    });

    afterEach(() => {
        store.clear();
    });

    // ─── Test Case 1 ─────────────────────────────────────────────────────────
    /**
     * Test Case 1 — processingMessages > 0 at shutdown: stop() must wait for in-flight processing
     *
     * Scenario: A handler for 'order.created' takes 300ms to complete.
     * stop() is called at 50ms (while the handler is still running).
     *
     * The bug: ResilientConsumer.waitForProcessing() used its own processingCount which
     * was decremented BEFORE AmqpQueue sent the ack. The fix delegates waitForProcessing()
     * to AmqpQueue which tracks both processingMessages and pendingAcks.
     *
     * We verify this by checking that stop() does NOT return before the handler finishes.
     * On unfixed code, stop() returns immediately (processingCount=0 before ack).
     *
     * Expected (fixed): stop() waits for queue.waitForProcessing() to complete.
     * Bug (unfixed):    stop() returns before handler finishes (processingCount race).
     *
     * Validates: Requirement 2.1
     */
    it('TC1 — stop() should wait for in-flight processing before returning (race condition)', async () => {
        let handlerFinished = false;
        let stopReturnedBeforeHandlerFinished = false;
        let consumeCallback: ((event: EventMessage) => Promise<void>) | null = null;

        // Build a mock AmqpQueue that:
        // 1. Captures the consume callback
        // 2. Simulates processingMessages > 0 while handler runs, then 0 after
        let mockProcessingMessages = 0;
        const mockWaitForProcessing = jest.fn().mockImplementation(async () => {
            // Simulate waiting: poll until processingMessages = 0
            while (mockProcessingMessages > 0) {
                await sleep(20);
            }
        });

        AmqpQueueMock.mockImplementation(() => ({
            connect: jest.fn().mockResolvedValue(undefined),
            consume: jest.fn().mockImplementation(async (_queue: string, cb: (event: EventMessage) => Promise<void>) => {
                consumeCallback = cb;
            }),
            cancelAllConsumers: jest.fn().mockResolvedValue(undefined),
            disconnect: jest.fn().mockResolvedValue(undefined),
            waitForProcessing: mockWaitForProcessing,
            closed: false,
            get processingMessages() { return mockProcessingMessages; },
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

        const slowHandler = jest.fn().mockImplementation(async () => {
            mockProcessingMessages++;
            await sleep(300); // handler takes 300ms
            handlerFinished = true;
            mockProcessingMessages--;
        });

        const consumer = new ResilientConsumer(buildConfig(store, slowHandler));
        await consumer.start();

        expect(consumeCallback).not.toBeNull();

        const testEvent: EventMessage = {
            messageId: 'evt-tc1-001',
            type: 'order.created',
            payload: { orderId: 'order-1' },
        };

        // Start processing in background (handler takes 300ms)
        consumeCallback!(testEvent).catch(() => {});

        // Wait until handler has started (50ms)
        await sleep(50);
        expect(mockProcessingMessages).toBe(1);

        // Call stop() while handler is running (processingMessages > 0)
        // On fixed code: stop() calls queue.waitForProcessing() which waits for handler
        await consumer.stop();

        // After stop() returns, check if it waited for the handler
        stopReturnedBeforeHandlerFinished = !handlerFinished;

        // This assertion FAILS on unfixed code:
        // stop() returns before handler finishes (processingCount race)
        expect(stopReturnedBeforeHandlerFinished).toBe(false);
        expect(mockWaitForProcessing).toHaveBeenCalled();
    }, 10_000);

    // ─── Test Case 2 ─────────────────────────────────────────────────────────
    /**
     * Test Case 2 — pendingAcks > 0 at shutdown
     *
     * Scenario: Messages are processed but acks are still in the buffer.
     * stop() is called → connection must NOT close before pendingAcks = 0.
     *
     * The bug: AmqpQueue has no `pendingAcks` counter. Without it, there is no way
     * to track acks that have been sent but not yet confirmed by the broker.
     *
     * Expected (fixed): AmqpQueue has a `pendingAcks` field that tracks pending acks.
     * Bug (unfixed):    AmqpQueue has no `pendingAcks` field → acks can be lost on shutdown.
     *
     * Validates: Requirement 2.3
     */
    it('TC2 — AmqpQueue should have a pendingAcks counter (currently missing)', () => {
        // Access the real (unmocked) AmqpQueue for this test
        jest.unmock('../../../src/broker/amqp-queue');
        const { AmqpQueue: RealAmqpQueue } = jest.requireActual('../../../src/broker/amqp-queue');

        const queue = new RealAmqpQueue('amqp://localhost:5672');

        // The bug: there is NO pendingAcks counter in the unfixed code
        // So we verify that the field doesn't exist (confirming the bug)
        const hasPendingAcksField = 'pendingAcks' in queue;

        // This assertion FAILS on unfixed code:
        // The unfixed AmqpQueue has no pendingAcks counter
        expect(hasPendingAcksField).toBe(true);
    });

    // ─── Test Case 3 ─────────────────────────────────────────────────────────
    /**
     * Test Case 3 — eventsInRetryState > 0 at shutdown
     *
     * Scenario: An event is in RETRY state in the store when stop() is called.
     * Expected (fixed): stop() calls revertRetryEvents() → event transitions to ERROR.
     * Bug (unfixed):    stop() does NOT call revertRetryEvents() → event stays in RETRY.
     *
     * Validates: Requirement 2.2
     */
    it('TC3 — event in RETRY state should be moved to ERROR after stop() (eventsInRetryState > 0)', async () => {
        AmqpQueueMock.mockImplementation(() => ({
            connect: jest.fn().mockResolvedValue(undefined),
            consume: jest.fn().mockResolvedValue(undefined),
            cancelAllConsumers: jest.fn().mockResolvedValue(undefined),
            disconnect: jest.fn().mockResolvedValue(undefined),
            closed: false,
            channel: {
                assertQueue: jest.fn().mockResolvedValue({ queue: 'test.queue' }),
                assertExchange: jest.fn().mockResolvedValue({}),
                bindQueue: jest.fn().mockResolvedValue({}),
                checkQueue: jest.fn().mockResolvedValue({ messageCount: 0 }),
            },
            connection: { on: jest.fn() },
        }));

        const consumer = new ResilientConsumer(
            buildConfig(store, jest.fn().mockResolvedValue(undefined))
        );
        await consumer.start();

        // Manually place an event in RETRY state in the store
        const retryEvent: EventMessage = {
            messageId: 'evt-tc3-retry-001',
            type: 'order.created',
            payload: { orderId: 'order-retry' },
            status: EventConsumeStatus.RETRY,
        };
        await store.saveEvent(retryEvent);
        await store.updateEventStatus(retryEvent, EventConsumeStatus.RETRY);

        // Verify it's in RETRY before stop()
        const beforeStop = await store.getEvent(retryEvent);
        expect(beforeStop?.status).toBe(EventConsumeStatus.RETRY);

        // Call stop() — should revert RETRY events to ERROR
        await consumer.stop();

        // After stop(), the event must NOT be in RETRY
        // (it should be ERROR — consumer was stopped during retry)
        const afterStop = await store.getEvent(retryEvent);

        // This assertion FAILS on unfixed code:
        // stop() has no revertRetryEvents() logic → event stays in RETRY
        expect(afterStop?.status).toBe(EventConsumeStatus.ERROR);
    }, 10_000);

    // ─── Test Case 4 ─────────────────────────────────────────────────────────
    /**
     * Test Case 4 — No SIGTERM handler registered
     *
     * Scenario: Before the fix, ResilientConsumer.start() does NOT register
     * process.once('SIGTERM') or process.once('SIGINT') handlers.
     *
     * Expected (fixed): After start(), process.listenerCount('SIGTERM') > 0.
     * Bug (unfixed):    process.listenerCount('SIGTERM') === 0 after start().
     *
     * Validates: Requirement 2.4
     */
    it('TC4 — SIGTERM handler should be registered after start() (currently missing)', async () => {
        AmqpQueueMock.mockImplementation(() => ({
            connect: jest.fn().mockResolvedValue(undefined),
            consume: jest.fn().mockResolvedValue(undefined),
            cancelAllConsumers: jest.fn().mockResolvedValue(undefined),
            disconnect: jest.fn().mockResolvedValue(undefined),
            closed: false,
            channel: {
                assertQueue: jest.fn().mockResolvedValue({ queue: 'test.queue' }),
                assertExchange: jest.fn().mockResolvedValue({}),
                bindQueue: jest.fn().mockResolvedValue({}),
                checkQueue: jest.fn().mockResolvedValue({ messageCount: 0 }),
            },
            connection: { on: jest.fn() },
        }));

        // Remove any existing SIGTERM listeners to get a clean baseline
        const existingListeners = process.rawListeners('SIGTERM');
        process.removeAllListeners('SIGTERM');

        const consumer = new ResilientConsumer(
            buildConfig(store, jest.fn().mockResolvedValue(undefined))
        );

        // Before start: no SIGTERM handler
        expect(process.listenerCount('SIGTERM')).toBe(0);

        await consumer.start();

        const sigtermCount = process.listenerCount('SIGTERM');

        // Restore original listeners
        process.removeAllListeners('SIGTERM');
        for (const listener of existingListeners) {
            process.on('SIGTERM', listener as (...args: any[]) => void);
        }

        await consumer.stop();

        // This assertion FAILS on unfixed code:
        // start() does not register any SIGTERM handler
        expect(sigtermCount).toBeGreaterThan(0);
    }, 10_000);
});
