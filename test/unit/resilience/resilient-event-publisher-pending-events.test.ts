import { ResilientEventPublisher } from '../../../src/resilience/resilient-event-publisher';
import { EventStoreMock } from '../../utils/event-store-mock';
import { AMQPLibMock } from '../../utils/amqplib-mock';
import { ResilientPublisherConfig, EventMessage } from '../../../src/types';
import { EventPublishStatus } from '../../../src/types';

// Mock amqplib
jest.mock('amqplib', () => {
    const mockLib = new (require('../../utils/amqplib-mock').AMQPLibMock)();
    return {
        connect: jest.fn((...args) => mockLib.connect(...args))
    };
});

// Mock the AmqpQueue
jest.mock('../../../src/broker/amqp-queue');

describe('ResilientEventPublisher - Pending Events Processing', () => {
    let publisher: ResilientEventPublisher;
    let mockStore: EventStoreMock;
    let config: ResilientPublisherConfig;
    let mockLib: AMQPLibMock;
    let globalInitSpy: jest.SpyInstance;

    beforeEach(() => {
        jest.useFakeTimers();
        mockStore = new EventStoreMock();
        mockLib = new AMQPLibMock();

        const amqplib = require('amqplib');
        amqplib.connect.mockImplementation((url: any) => mockLib.connect(url));

        config = {
            connection: 'amqp://localhost:5672',
            queue: 'test.queue',
            instantPublish: false,
            store: mockStore,
            pendingEventsCheckIntervalMs: 1000
        };

        // Mock the background initialization check globally
        globalInitSpy = jest.spyOn(ResilientEventPublisher.prototype as any, 'checkStoreConnection')
            .mockImplementation(async () => { });
    });

    afterEach(() => {
        if (publisher && (publisher as any).pendingEventsInterval) {
            publisher.stopPendingEventsCheck();
        }
        if (publisher && publisher.isConnected()) {
            publisher.disconnect().catch(() => { });
        }
        mockStore.clear();
        mockLib.reset();
        if (globalInitSpy) {
            globalInitSpy.mockRestore();
        }
        jest.clearAllMocks();
        jest.useRealTimers();
    });

    describe('processPendingEvents with rate limiting', () => {
        beforeEach(() => {
            const AmqpQueue = require('../../../src/broker/amqp-queue').AmqpQueue;
            AmqpQueue.mockImplementation(() => ({
                connect: jest.fn().mockResolvedValue(undefined),
                disconnect: jest.fn().mockResolvedValue(undefined),
                forceClose: jest.fn().mockResolvedValue(undefined),
                publish: jest.fn().mockResolvedValue(undefined),
                closed: false
            }));
        });

        it('should process events respecting maxPublishesPerSecond rate limit', async () => {
            jest.useRealTimers();
            
            publisher = new ResilientEventPublisher(config);
            (publisher as any).storeConnected = true;

            // Create 100 pending events
            const events: EventMessage[] = [];
            for (let i = 0; i < 100; i++) {
                const event = {
                    messageId: `msg-${i}`,
                    type: 'test.event',
                    payload: { data: `test-${i}` },
                    properties: { timestamp: Date.now() + i }
                };
                events.push(event);
                await mockStore.saveEvent({ ...event, status: EventPublishStatus.PENDING });
            }

            const startTime = Date.now();
            
            await publisher.processPendingEvents({
                batchSize: 100,
                maxPublishesPerSecond: 50,
                maxConcurrentPublishes: 10
            });

            const elapsed = Date.now() - startTime;
            
            // With 100 events at 50/s, should take at least 1 second (relaxed for CI variability)
            // Token bucket allows some burst capacity, so timing can vary significantly in CI
            expect(elapsed).toBeGreaterThan(800);
            
            // Verify all events were processed
            for (const event of events) {
                const saved = await mockStore.getEvent(event);
                expect(saved?.status).toBe(EventPublishStatus.PUBLISHED);
            }

            jest.useFakeTimers();
        }, 10000);

        it('should handle high concurrency with rate limiting', async () => {
            jest.useRealTimers();
            
            publisher = new ResilientEventPublisher(config);
            (publisher as any).storeConnected = true;

            // Create 200 pending events
            const events: EventMessage[] = [];
            for (let i = 0; i < 200; i++) {
                const event = {
                    messageId: `msg-${i}`,
                    type: 'test.event',
                    payload: { data: `test-${i}` },
                    properties: { timestamp: Date.now() + i }
                };
                events.push(event);
                await mockStore.saveEvent({ ...event, status: EventPublishStatus.PENDING });
            }

            await publisher.processPendingEvents({
                batchSize: 200,
                maxPublishesPerSecond: 100,
                maxConcurrentPublishes: 50
            });

            // Verify all events were processed
            let successCount = 0;
            for (const event of events) {
                const saved = await mockStore.getEvent(event);
                if (saved?.status === EventPublishStatus.PUBLISHED) {
                    successCount++;
                }
            }
            
            expect(successCount).toBe(200);

            jest.useFakeTimers();
        }, 15000);

        it('should handle errors during rate-limited processing', async () => {
            jest.useRealTimers();
            
            const AmqpQueue = require('../../../src/broker/amqp-queue').AmqpQueue;
            let publishCount = 0;
            AmqpQueue.mockImplementation(() => ({
                connect: jest.fn().mockResolvedValue(undefined),
                disconnect: jest.fn().mockResolvedValue(undefined),
                forceClose: jest.fn().mockResolvedValue(undefined),
                publish: jest.fn().mockImplementation(async () => {
                    publishCount++;
                    // Fail every 5th message
                    if (publishCount % 5 === 0) {
                        throw new Error('Publish failed');
                    }
                }),
                closed: false
            }));

            publisher = new ResilientEventPublisher(config);
            (publisher as any).storeConnected = true;

            // Create 50 pending events
            const events: EventMessage[] = [];
            for (let i = 0; i < 50; i++) {
                const event = {
                    messageId: `msg-${i}`,
                    type: 'test.event',
                    payload: { data: `test-${i}` },
                    properties: { timestamp: Date.now() + i }
                };
                events.push(event);
                await mockStore.saveEvent({ ...event, status: EventPublishStatus.PENDING });
            }

            await publisher.processPendingEvents({
                batchSize: 50,
                maxPublishesPerSecond: 25,
                maxConcurrentPublishes: 5
            });

            // Count successes and errors
            let successCount = 0;
            let errorCount = 0;
            for (const event of events) {
                const saved = await mockStore.getEvent(event);
                if (saved?.status === EventPublishStatus.PUBLISHED) {
                    successCount++;
                } else if (saved?.status === EventPublishStatus.ERROR) {
                    errorCount++;
                }
            }
            
            expect(successCount).toBeGreaterThan(0);
            expect(errorCount).toBeGreaterThan(0);
            expect(successCount + errorCount).toBe(50);

            jest.useFakeTimers();
        }, 15000);

        it('should process empty event list without errors', async () => {
            publisher = new ResilientEventPublisher(config);
            (publisher as any).storeConnected = true;

            // No pending events
            await expect(publisher.processPendingEvents({
                batchSize: 100,
                maxPublishesPerSecond: 50,
                maxConcurrentPublishes: 10
            })).resolves.not.toThrow();
        });

        it('should handle single event processing', async () => {
            jest.useRealTimers();
            
            publisher = new ResilientEventPublisher(config);
            (publisher as any).storeConnected = true;

            const event = {
                messageId: 'msg-single',
                type: 'test.event',
                payload: { data: 'test' },
                properties: { timestamp: Date.now() }
            };
            await mockStore.saveEvent({ ...event, status: EventPublishStatus.PENDING });

            await publisher.processPendingEvents({
                batchSize: 1,
                maxPublishesPerSecond: 10,
                maxConcurrentPublishes: 1
            });

            const saved = await mockStore.getEvent(event);
            expect(saved?.status).toBe(EventPublishStatus.PUBLISHED);

            jest.useFakeTimers();
        }, 10000);

        it('should respect token bucket refill rate', async () => {
            jest.useRealTimers();
            
            publisher = new ResilientEventPublisher(config);
            (publisher as any).storeConnected = true;

            // Create more events to make timing more reliable
            const events: EventMessage[] = [];
            for (let i = 0; i < 50; i++) {
                const event = {
                    messageId: `msg-${i}`,
                    type: 'test.event',
                    payload: { data: `test-${i}` },
                    properties: { timestamp: Date.now() + i }
                };
                events.push(event);
                await mockStore.saveEvent({ ...event, status: EventPublishStatus.PENDING });
            }

            const startTime = Date.now();
            
            await publisher.processPendingEvents({
                batchSize: 50,
                maxPublishesPerSecond: 25,
                maxConcurrentPublishes: 5
            });

            const elapsed = Date.now() - startTime;
            
            // With 50 events at 25/s, should take at least 800ms (very relaxed for CI variability)
            // Token bucket allows burst capacity and CI can be slow/fast unpredictably
            expect(elapsed).toBeGreaterThan(800);
            
            // Verify all events were processed
            for (const event of events) {
                const saved = await mockStore.getEvent(event);
                expect(saved?.status).toBe(EventPublishStatus.PUBLISHED);
            }

            jest.useFakeTimers();
        }, 15000);

        it('should handle concurrent processing with token bucket', async () => {
            jest.useRealTimers();
            
            const AmqpQueue = require('../../../src/broker/amqp-queue').AmqpQueue;
            const publishDelays: number[] = [];
            AmqpQueue.mockImplementation(() => ({
                connect: jest.fn().mockResolvedValue(undefined),
                disconnect: jest.fn().mockResolvedValue(undefined),
                forceClose: jest.fn().mockResolvedValue(undefined),
                publish: jest.fn().mockImplementation(async () => {
                    // Simulate variable processing time
                    const delay = Math.random() * 50;
                    publishDelays.push(delay);
                    await new Promise(resolve => setTimeout(resolve, delay));
                }),
                closed: false
            }));

            publisher = new ResilientEventPublisher(config);
            (publisher as any).storeConnected = true;

            // Create 40 pending events
            const events: EventMessage[] = [];
            for (let i = 0; i < 40; i++) {
                const event = {
                    messageId: `msg-${i}`,
                    type: 'test.event',
                    payload: { data: `test-${i}` },
                    properties: { timestamp: Date.now() + i }
                };
                events.push(event);
                await mockStore.saveEvent({ ...event, status: EventPublishStatus.PENDING });
            }

            await publisher.processPendingEvents({
                batchSize: 40,
                maxPublishesPerSecond: 30,
                maxConcurrentPublishes: 10
            });

            // Verify all events were processed despite variable delays
            for (const event of events) {
                const saved = await mockStore.getEvent(event);
                expect(saved?.status).toBe(EventPublishStatus.PUBLISHED);
            }

            jest.useFakeTimers();
        }, 15000);

        it('should process multiple batches with rate limiting', async () => {
            jest.useRealTimers();
            
            publisher = new ResilientEventPublisher(config);
            (publisher as any).storeConnected = true;

            // Create 150 pending events (will require multiple batches)
            const events: EventMessage[] = [];
            for (let i = 0; i < 150; i++) {
                const event = {
                    messageId: `msg-${i}`,
                    type: 'test.event',
                    payload: { data: `test-${i}` },
                    properties: { timestamp: Date.now() + i }
                };
                events.push(event);
                await mockStore.saveEvent({ ...event, status: EventPublishStatus.PENDING });
            }

            await publisher.processPendingEvents({
                batchSize: 50,
                maxPublishesPerSecond: 40,
                maxConcurrentPublishes: 10
            });

            // Verify all events were processed across batches
            let successCount = 0;
            for (const event of events) {
                const saved = await mockStore.getEvent(event);
                if (saved?.status === EventPublishStatus.PUBLISHED) {
                    successCount++;
                }
            }
            
            expect(successCount).toBe(150);

            jest.useFakeTimers();
        }, 20000);
    });

    describe('configuration validation', () => {
        it('should throw error for invalid batchSize', () => {
            config.pendingEventsBatchSize = -1;
            
            expect(() => {
                publisher = new ResilientEventPublisher(config);
            }).toThrow('Configuration error: "pendingEventsBatchSize" must be a positive integer');
        });

        it('should throw error for invalid maxPublishesPerSecond', () => {
            config.pendingEventsMaxPublishesPerSecond = 0;
            
            expect(() => {
                publisher = new ResilientEventPublisher(config);
            }).toThrow('Configuration error: "pendingEventsMaxPublishesPerSecond" must be a positive integer');
        });

        it('should throw error for invalid maxConcurrentPublishes', () => {
            config.pendingEventsMaxConcurrentPublishes = -5;
            
            expect(() => {
                publisher = new ResilientEventPublisher(config);
            }).toThrow('Configuration error: "pendingEventsMaxConcurrentPublishes" must be a positive integer');
        });

        it('should throw error for non-integer batchSize', () => {
            config.pendingEventsBatchSize = 10.5;
            
            expect(() => {
                publisher = new ResilientEventPublisher(config);
            }).toThrow('Configuration error: "pendingEventsBatchSize" must be a positive integer');
        });

        it('should use default values when options not provided', async () => {
            publisher = new ResilientEventPublisher(config);
            (publisher as any).storeConnected = true;

            const event = {
                messageId: 'msg-default',
                type: 'test.event',
                payload: { data: 'test' },
                properties: { timestamp: Date.now() }
            };
            await mockStore.saveEvent({ ...event, status: EventPublishStatus.PENDING });

            // Call without options to use defaults
            await publisher.processPendingEvents();

            const saved = await mockStore.getEvent(event);
            expect(saved?.status).toBe(EventPublishStatus.PUBLISHED);
        });
    });

    describe('metrics tracking', () => {
        it('should track successful publishes in metrics', async () => {
            config.metricsEnabled = true;
            
            const AmqpQueue = require('../../../src/broker/amqp-queue').AmqpQueue;
            AmqpQueue.mockImplementation(() => ({
                connect: jest.fn().mockResolvedValue(undefined),
                disconnect: jest.fn().mockResolvedValue(undefined),
                forceClose: jest.fn().mockResolvedValue(undefined),
                publish: jest.fn().mockResolvedValue(undefined),
                closed: false
            }));

            publisher = new ResilientEventPublisher(config);
            (publisher as any).storeConnected = true;

            const event = {
                messageId: 'msg-metrics',
                type: 'test.event',
                payload: { data: 'test' },
                properties: { timestamp: Date.now() }
            };
            await mockStore.saveEvent({ ...event, status: EventPublishStatus.PENDING });

            await publisher.processPendingEvents();

            const metrics = publisher.getMetrics();
            expect(metrics).toBeDefined();
            expect(metrics?.messagesPublished).toBeGreaterThan(0);
        });

        it('should track errors in metrics', async () => {
            config.metricsEnabled = true;
            
            const AmqpQueue = require('../../../src/broker/amqp-queue').AmqpQueue;
            AmqpQueue.mockImplementation(() => ({
                connect: jest.fn().mockResolvedValue(undefined),
                disconnect: jest.fn().mockResolvedValue(undefined),
                forceClose: jest.fn().mockResolvedValue(undefined),
                publish: jest.fn().mockRejectedValue(new Error('Publish failed')),
                closed: false
            }));

            publisher = new ResilientEventPublisher(config);
            (publisher as any).storeConnected = true;

            const event = {
                messageId: 'msg-error',
                type: 'test.event',
                payload: { data: 'test' },
                properties: { timestamp: Date.now() }
            };
            await mockStore.saveEvent({ ...event, status: EventPublishStatus.PENDING });

            await publisher.processPendingEvents();

            const metrics = publisher.getMetrics();
            expect(metrics).toBeDefined();
            expect(metrics?.processingErrors).toBeGreaterThan(0);
        });
    });

    describe('batch status updates', () => {
        it('should use batchUpdateEventStatus when available', async () => {
            jest.useRealTimers();
            
            const AmqpQueue = require('../../../src/broker/amqp-queue').AmqpQueue;
            AmqpQueue.mockImplementation(() => ({
                connect: jest.fn().mockResolvedValue(undefined),
                disconnect: jest.fn().mockResolvedValue(undefined),
                forceClose: jest.fn().mockResolvedValue(undefined),
                publish: jest.fn().mockResolvedValue(undefined),
                closed: false
            }));

            publisher = new ResilientEventPublisher(config);
            (publisher as any).storeConnected = true;

            // Create 50 pending events
            const events: EventMessage[] = [];
            for (let i = 0; i < 50; i++) {
                const event = {
                    messageId: `msg-batch-${i}`,
                    type: 'test.event',
                    payload: { data: `test-${i}` },
                    properties: { timestamp: Date.now() + i }
                };
                events.push(event);
                await mockStore.saveEvent({ ...event, status: EventPublishStatus.PENDING });
            }

            const batchUpdateSpy = jest.spyOn(mockStore, 'batchUpdateEventStatus');

            await publisher.processPendingEvents({
                batchSize: 50,
                maxPublishesPerSecond: 30,
                maxConcurrentPublishes: 10
            });

            // Verify batchUpdateEventStatus was called
            expect(batchUpdateSpy).toHaveBeenCalled();
            expect(mockStore.getCallCount('batchUpdateEventStatus')).toBeGreaterThan(0);

            // Verify all events were updated
            for (const event of events) {
                const saved = await mockStore.getEvent(event);
                expect(saved?.status).toBe(EventPublishStatus.PUBLISHED);
            }

            jest.useFakeTimers();
        }, 15000);

        it('should fallback to individual updates if batchUpdateEventStatus fails (lines 511-516)', async () => {
            jest.useRealTimers();
            
            const AmqpQueue = require('../../../src/broker/amqp-queue').AmqpQueue;
            AmqpQueue.mockImplementation(() => ({
                connect: jest.fn().mockResolvedValue(undefined),
                disconnect: jest.fn().mockResolvedValue(undefined),
                forceClose: jest.fn().mockResolvedValue(undefined),
                publish: jest.fn().mockResolvedValue(undefined),
                closed: false
            }));

            publisher = new ResilientEventPublisher(config);
            (publisher as any).storeConnected = true;

            // Create 20 pending events
            const events: EventMessage[] = [];
            for (let i = 0; i < 20; i++) {
                const event = {
                    messageId: `msg-fallback-${i}`,
                    type: 'test.event',
                    payload: { data: `test-${i}` },
                    properties: { timestamp: Date.now() + i }
                };
                events.push(event);
                await mockStore.saveEvent({ ...event, status: EventPublishStatus.PENDING });
            }

            // Make batchUpdateEventStatus fail on first call, then succeed
            let batchCallCount = 0;
            const originalBatchUpdate = mockStore.batchUpdateEventStatus.bind(mockStore);
            const updateEventStatusSpy = jest.spyOn(mockStore, 'updateEventStatus');
            
            mockStore.batchUpdateEventStatus = jest.fn(async (updates) => {
                batchCallCount++;
                if (batchCallCount === 1) {
                    // First call fails - should trigger fallback to individual updates (lines 511-516)
                    throw new Error('Batch update failed');
                }
                return originalBatchUpdate(updates);
            });

            await publisher.processPendingEvents({
                batchSize: 20,
                maxPublishesPerSecond: 15,
                maxConcurrentPublishes: 5
            });

            // Verify fallback to individual updates was triggered (lines 511-516)
            expect(updateEventStatusSpy).toHaveBeenCalled();
            
            // Verify all events were updated despite the batch failure
            for (const event of events) {
                const saved = await mockStore.getEvent(event);
                expect(saved?.status).toBe(EventPublishStatus.PUBLISHED);
            }

            jest.useFakeTimers();
        }, 15000);

        it('should use individual updates in parallel when batchUpdateEventStatus not available (lines 519-521)', async () => {
            jest.useRealTimers();
            
            const AmqpQueue = require('../../../src/broker/amqp-queue').AmqpQueue;
            AmqpQueue.mockImplementation(() => ({
                connect: jest.fn().mockResolvedValue(undefined),
                disconnect: jest.fn().mockResolvedValue(undefined),
                forceClose: jest.fn().mockResolvedValue(undefined),
                publish: jest.fn().mockResolvedValue(undefined),
                closed: false
            }));

            // Create a custom store WITHOUT batchUpdateEventStatus from the start
            const storeWithoutBatch: any = {
                events: new Map<string, EventMessage>(),
                callCounts: new Map<string, number>(),
                
                async saveEvent(event: EventMessage): Promise<void> {
                    this.events.set(event.messageId, { ...event });
                    const count = this.callCounts.get('saveEvent') || 0;
                    this.callCounts.set('saveEvent', count + 1);
                },
                
                async updateEventStatus(event: EventMessage, status: EventPublishStatus): Promise<void> {
                    const count = this.callCounts.get('updateEventStatus') || 0;
                    this.callCounts.set('updateEventStatus', count + 1);
                    const existingEvent = this.events.get(event.messageId);
                    if (existingEvent) {
                        existingEvent.status = status;
                    }
                },
                
                async getEvent(event: EventMessage): Promise<EventMessage | null> {
                    const storedEvent = this.events.get(event.messageId);
                    return storedEvent ? { ...storedEvent } : null;
                },
                
                async getPendingEvents(status: EventPublishStatus): Promise<EventMessage[]> {
                    const pendingEvents: EventMessage[] = [];
                    for (const event of this.events.values()) {
                        if (event.status === status) {
                            pendingEvents.push({ ...event });
                        }
                    }
                    return pendingEvents;
                },
                
                getCallCount(method: string): number {
                    return this.callCounts.get(method) || 0;
                },
                
                resetCallCounts(): void {
                    this.callCounts.clear();
                }
                // NOTE: batchUpdateEventStatus is intentionally NOT defined
            };

            const updateEventStatusSpy = jest.spyOn(storeWithoutBatch, 'updateEventStatus');

            const configWithoutBatch = {
                ...config,
                store: storeWithoutBatch
            };

            publisher = new ResilientEventPublisher(configWithoutBatch);
            (publisher as any).storeConnected = true;

            // Create events
            const events: EventMessage[] = [];
            for (let i = 0; i < 15; i++) {
                const event = {
                    messageId: `msg-individual-${i}`,
                    type: 'test.event',
                    payload: { data: `test-${i}` },
                    properties: { timestamp: Date.now() + i }
                };
                events.push(event);
                await storeWithoutBatch.saveEvent({ ...event, status: EventPublishStatus.PENDING });
            }

            // Clear spy and counts to only track calls during processPendingEvents
            updateEventStatusSpy.mockClear();
            storeWithoutBatch.resetCallCounts();

            await publisher.processPendingEvents({
                batchSize: 15,
                maxPublishesPerSecond: 20,
                maxConcurrentPublishes: 5
            });

            // Verify individual updates were used (lines 519-521)
            const callCount = storeWithoutBatch.getCallCount('updateEventStatus');
            expect(callCount).toBeGreaterThanOrEqual(15);
            expect(updateEventStatusSpy).toHaveBeenCalled();
            
            // Verify all events were updated
            for (const event of events) {
                const saved = await storeWithoutBatch.getEvent(event);
                expect(saved?.status).toBe(EventPublishStatus.PUBLISHED);
            }

            jest.useFakeTimers();
        }, 15000);
    });
});
