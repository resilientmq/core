import { ResilientEventPublisher } from '../../src/resilience/resilient-event-publisher';
import { EventStoreMock } from '../utils/event-store-mock';
import { createTestEvent } from '../fixtures/events';
import { AmqpQueue } from '../../src/broker/amqp-queue';

// Mock AmqpQueue
jest.mock('../../src/broker/amqp-queue');

describe('ResilientEventPublisher - Idle Connection Management', () => {
    let publisher: ResilientEventPublisher;
    let store: EventStoreMock;
    let mockQueue: jest.Mocked<AmqpQueue>;

    beforeEach(() => {
        store = new EventStoreMock();
        
        // Setup mock queue
        mockQueue = new AmqpQueue('amqp://localhost') as jest.Mocked<AmqpQueue>;
        mockQueue.connect = jest.fn().mockResolvedValue(undefined);
        mockQueue.disconnect = jest.fn().mockResolvedValue(undefined);
        mockQueue.publish = jest.fn().mockResolvedValue(undefined);
        mockQueue.closed = false;

        (AmqpQueue as jest.MockedClass<typeof AmqpQueue>).mockImplementation(() => mockQueue);
    });

    afterEach(async () => {
        if (publisher) {
            publisher.stopPendingEventsCheck();
            await publisher.disconnect();
        }
        store.clear();
        jest.clearAllMocks();
        jest.clearAllTimers();
    });

    it('should use default 10 second timeout when idleTimeoutMs is not configured', async () => {
        jest.useFakeTimers();

        publisher = new ResilientEventPublisher({
            connection: 'amqp://localhost',
            queue: 'test-queue',
            store,
            instantPublish: true
            // idleTimeoutMs not set - should default to 10000ms
        });

        const event = createTestEvent({ test: 'data' });
        await publisher.publish(event);

        expect(mockQueue.connect).toHaveBeenCalledTimes(1);
        expect(publisher.isConnected()).toBe(true);

        // Advance time but not past default timeout
        jest.advanceTimersByTime(9000);
        await Promise.resolve();

        // Connection should still be open
        expect(publisher.isConnected()).toBe(true);
        expect(mockQueue.disconnect).not.toHaveBeenCalled();

        // Advance past default timeout
        jest.advanceTimersByTime(1100);
        await Promise.resolve();

        // Connection should be closed
        expect(mockQueue.disconnect).toHaveBeenCalled();
    });

    it('should close connection after idle timeout', async () => {
        jest.useFakeTimers();

        publisher = new ResilientEventPublisher({
            connection: 'amqp://localhost',
            queue: 'test-queue',
            store,
            instantPublish: true,
            idleTimeoutMs: 1000 // 1 second
        });

        const event = createTestEvent({ test: 'data' });
        await publisher.publish(event);

        expect(mockQueue.connect).toHaveBeenCalledTimes(1);
        expect(publisher.isConnected()).toBe(true);

        // Fast-forward time past idle timeout
        jest.advanceTimersByTime(1100);
        await Promise.resolve(); // Allow promises to resolve

        // Connection should be closed
        expect(mockQueue.disconnect).toHaveBeenCalled();
    });

    it('should reconnect automatically when publishing after idle disconnect', async () => {
        jest.useFakeTimers();

        publisher = new ResilientEventPublisher({
            connection: 'amqp://localhost',
            queue: 'test-queue',
            store,
            instantPublish: true,
            idleTimeoutMs: 1000
        });

        // First publish
        const event1 = createTestEvent({ test: 'data1' });
        await publisher.publish(event1);

        expect(mockQueue.connect).toHaveBeenCalledTimes(1);

        // Wait for idle timeout
        jest.advanceTimersByTime(1100);
        await Promise.resolve();

        // Manually set connected to false to simulate disconnect
        mockQueue.disconnect.mockImplementation(async () => {
            (publisher as any).connected = false;
        });

        // Second publish after idle timeout
        const event2 = createTestEvent({ test: 'data2' });
        await publisher.publish(event2);

        // Should have reconnected
        expect(mockQueue.connect).toHaveBeenCalledTimes(2);
    });

    it('should reset idle timer on each publish', async () => {
        jest.useFakeTimers();

        publisher = new ResilientEventPublisher({
            connection: 'amqp://localhost',
            queue: 'test-queue',
            store,
            instantPublish: true,
            idleTimeoutMs: 1000
        });

        // First publish
        await publisher.publish(createTestEvent({ test: 'data1' }));
        expect(publisher.isConnected()).toBe(true);

        // Advance time but not past timeout
        jest.advanceTimersByTime(800);

        // Second publish resets timer
        await publisher.publish(createTestEvent({ test: 'data2' }));

        // Advance time again
        jest.advanceTimersByTime(800);

        // Connection should still be open (timer was reset)
        expect(publisher.isConnected()).toBe(true);
        expect(mockQueue.disconnect).not.toHaveBeenCalled();
    });

    it('should not start idle monitoring when idleTimeoutMs is 0', async () => {
        publisher = new ResilientEventPublisher({
            connection: 'amqp://localhost',
            queue: 'test-queue',
            store,
            instantPublish: true,
            idleTimeoutMs: 0
        });

        const event = createTestEvent({ test: 'data' });
        await publisher.publish(event);

        expect(publisher.isConnected()).toBe(true);

        // Check that no timer was created
        const timers = jest.getTimerCount();
        expect(timers).toBe(0);
    });

    it('should clear idle timer on manual disconnect', async () => {
        jest.useFakeTimers();

        publisher = new ResilientEventPublisher({
            connection: 'amqp://localhost',
            queue: 'test-queue',
            store,
            instantPublish: true,
            idleTimeoutMs: 5000
        });

        await publisher.publish(createTestEvent({ test: 'data' }));
        expect(publisher.isConnected()).toBe(true);

        // Manually disconnect
        await publisher.disconnect();

        // Advance time past what would have been the idle timeout
        jest.advanceTimersByTime(6000);

        // disconnect should only have been called once (manual call)
        expect(mockQueue.disconnect).toHaveBeenCalledTimes(1);
    });
});
