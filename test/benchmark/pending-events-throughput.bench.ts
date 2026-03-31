import { ResilientEventPublisher } from '../../src/resilience/resilient-event-publisher';
import { EventStoreMock } from '../utils/event-store-mock';
import { AMQPLibMock } from '../utils/amqplib-mock';
import { ResilientPublisherConfig, EventMessage, EventPublishStatus } from '../../src/types';

// Mock amqplib
jest.mock('amqplib', () => {
    const mockLib = new (require('../utils/amqplib-mock').AMQPLibMock)();
    return {
        connect: jest.fn((...args) => mockLib.connect(...args))
    };
});

// Mock the AmqpQueue
jest.mock('../../src/broker/amqp-queue');

describe('Benchmark: Pending Events Throughput', () => {
    let publisher: ResilientEventPublisher;
    let mockStore: EventStoreMock;
    let config: ResilientPublisherConfig;
    let mockLib: AMQPLibMock;
    let globalInitSpy: jest.SpyInstance;

    beforeEach(() => {
        mockStore = new EventStoreMock();
        mockLib = new AMQPLibMock();

        const amqplib = require('amqplib');
        amqplib.connect.mockImplementation((url: any) => mockLib.connect(url));

        config = {
            connection: 'amqp://localhost:5672',
            queue: 'benchmark.queue',
            instantPublish: false,
            store: mockStore,
            metricsEnabled: true
        };

        // Mock the background initialization check
        globalInitSpy = jest.spyOn(ResilientEventPublisher.prototype as any, 'checkStoreConnection')
            .mockImplementation(async () => { });

        // Mock AmqpQueue for fast publishing
        const AmqpQueue = require('../../src/broker/amqp-queue').AmqpQueue;
        AmqpQueue.mockImplementation(() => ({
            connect: jest.fn().mockResolvedValue(undefined),
            disconnect: jest.fn().mockResolvedValue(undefined),
            forceClose: jest.fn().mockResolvedValue(undefined),
            publish: jest.fn().mockResolvedValue(undefined),
            closed: false
        }));
    });

    afterEach(() => {
        if (publisher && publisher.isConnected()) {
            publisher.disconnect().catch(() => { });
        }
        mockStore.clear();
        mockLib.reset();
        if (globalInitSpy) {
            globalInitSpy.mockRestore();
        }
        jest.clearAllMocks();
    });

    it('should measure throughput for 1,000 events', async () => {
        const eventCount = 1000;
        
        publisher = new ResilientEventPublisher(config);
        (publisher as any).storeConnected = true;

        // Create pending events
        console.log(`\n📊 Creating ${eventCount} pending events...`);
        const events: EventMessage[] = [];
        for (let i = 0; i < eventCount; i++) {
            const event = {
                messageId: `msg-${i}`,
                type: 'benchmark.event',
                payload: { data: `test-${i}`, index: i },
                properties: { timestamp: Date.now() + i }
            };
            events.push(event);
            await mockStore.saveEvent({ ...event, status: EventPublishStatus.PENDING });
        }

        console.log(`✅ ${eventCount} events created in store`);

        // Measure processing time
        console.log(`\n🚀 Starting processPendingEvents...`);
        const startTime = Date.now();
        
        await publisher.processPendingEvents({
            batchSize: 1000
        });

        const elapsed = Date.now() - startTime;
        const throughput = Math.round((eventCount / elapsed) * 1000);

        // Verify all events were processed
        let successCount = 0;
        for (const event of events) {
            const saved = await mockStore.getEvent(event);
            if (saved?.status === EventPublishStatus.PUBLISHED) {
                successCount++;
            }
        }

        // Get metrics
        const metrics = publisher.getMetrics();

        // Print results
        console.log(`\n📈 BENCHMARK RESULTS:`);
        console.log(`   Events processed: ${successCount}/${eventCount}`);
        console.log(`   Time elapsed: ${elapsed}ms`);
        console.log(`   Throughput: ${throughput} msg/s`);
        console.log(`   Avg time per event: ${(elapsed / eventCount).toFixed(2)}ms`);
        console.log(`   Metrics:`);
        console.log(`     - Messages published: ${metrics?.messagesPublished}`);
        console.log(`     - Processing errors: ${metrics?.processingErrors}`);
        console.log(`     - Batch updates called: ${mockStore.getCallCount('batchUpdateEventStatus')}`);
        console.log(`     - Individual updates called: ${mockStore.getCallCount('updateEventStatus')}`);

        expect(successCount).toBe(eventCount);
        expect(throughput).toBeGreaterThan(0);
    }, 30000);

    it('should measure throughput for 5,000 events', async () => {
        const eventCount = 5000;
        
        publisher = new ResilientEventPublisher(config);
        (publisher as any).storeConnected = true;

        // Create pending events
        console.log(`\n📊 Creating ${eventCount} pending events...`);
        const events: EventMessage[] = [];
        for (let i = 0; i < eventCount; i++) {
            const event = {
                messageId: `msg-${i}`,
                type: 'benchmark.event',
                payload: { data: `test-${i}`, index: i },
                properties: { timestamp: Date.now() + i }
            };
            events.push(event);
            await mockStore.saveEvent({ ...event, status: EventPublishStatus.PENDING });
        }

        console.log(`✅ ${eventCount} events created in store`);

        // Measure processing time
        console.log(`\n🚀 Starting processPendingEvents...`);
        const startTime = Date.now();
        
        await publisher.processPendingEvents({
            batchSize: 1000
        });

        const elapsed = Date.now() - startTime;
        const throughput = Math.round((eventCount / elapsed) * 1000);

        // Verify all events were processed
        let successCount = 0;
        for (const event of events) {
            const saved = await mockStore.getEvent(event);
            if (saved?.status === EventPublishStatus.PUBLISHED) {
                successCount++;
            }
        }

        // Get metrics
        const metrics = publisher.getMetrics();

        // Print results
        console.log(`\n📈 BENCHMARK RESULTS:`);
        console.log(`   Events processed: ${successCount}/${eventCount}`);
        console.log(`   Time elapsed: ${elapsed}ms`);
        console.log(`   Throughput: ${throughput} msg/s`);
        console.log(`   Avg time per event: ${(elapsed / eventCount).toFixed(2)}ms`);
        console.log(`   Metrics:`);
        console.log(`     - Messages published: ${metrics?.messagesPublished}`);
        console.log(`     - Processing errors: ${metrics?.processingErrors}`);
        console.log(`     - Batch updates called: ${mockStore.getCallCount('batchUpdateEventStatus')}`);
        console.log(`     - Individual updates called: ${mockStore.getCallCount('updateEventStatus')}`);

        expect(successCount).toBe(eventCount);
        expect(throughput).toBeGreaterThan(0);
    }, 60000);

    it('should measure throughput for 10,000 events with different batch sizes', async () => {
        const eventCount = 10000;
        const batchSizes = [100, 500, 1000, 2000];
        const results: Array<{ batchSize: number; throughput: number; elapsed: number }> = [];

        for (const batchSize of batchSizes) {
            // Reset store
            mockStore.clear();
            
            // Create new publisher
            publisher = new ResilientEventPublisher(config);
            (publisher as any).storeConnected = true;

            // Create pending events
            console.log(`\n📊 Testing with batchSize=${batchSize}...`);
            const events: EventMessage[] = [];
            for (let i = 0; i < eventCount; i++) {
                const event = {
                    messageId: `msg-${batchSize}-${i}`,
                    type: 'benchmark.event',
                    payload: { data: `test-${i}`, index: i },
                    properties: { timestamp: Date.now() + i }
                };
                events.push(event);
                await mockStore.saveEvent({ ...event, status: EventPublishStatus.PENDING });
            }

            // Measure processing time
            const startTime = Date.now();
            
            await publisher.processPendingEvents({
                batchSize
            });

            const elapsed = Date.now() - startTime;
            const throughput = Math.round((eventCount / elapsed) * 1000);

            results.push({ batchSize, throughput, elapsed });

            console.log(`   ✅ Batch ${batchSize}: ${throughput} msg/s (${elapsed}ms)`);

            // Cleanup
            await publisher.disconnect();
        }

        // Print comparison
        console.log(`\n📊 BATCH SIZE COMPARISON (${eventCount} events):`);
        console.log(`   ┌─────────────┬──────────────┬─────────────┐`);
        console.log(`   │ Batch Size  │  Throughput  │    Time     │`);
        console.log(`   ├─────────────┼──────────────┼─────────────┤`);
        for (const result of results) {
            const batchStr = result.batchSize.toString().padStart(6);
            const throughputStr = `${result.throughput} msg/s`.padStart(11);
            const timeStr = `${result.elapsed}ms`.padStart(9);
            console.log(`   │  ${batchStr}     │ ${throughputStr} │  ${timeStr}  │`);
        }
        console.log(`   └─────────────┴──────────────┴─────────────┘`);

        // Find best batch size
        const best = results.reduce((prev, curr) => 
            curr.throughput > prev.throughput ? curr : prev
        );
        console.log(`\n🏆 Best performance: batchSize=${best.batchSize} with ${best.throughput} msg/s`);

        expect(results.length).toBe(batchSizes.length);
    }, 180000); // 3 minutes - processes 10k events with 4 different batch sizes

    it('should measure throughput with store that does NOT support batch updates', async () => {
        const eventCount = 1000;

        // Create store without batch update support
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
            }
            // NOTE: batchUpdateEventStatus is intentionally NOT defined
        };

        const configWithoutBatch = {
            ...config,
            store: storeWithoutBatch
        };

        publisher = new ResilientEventPublisher(configWithoutBatch);
        (publisher as any).storeConnected = true;

        // Create pending events
        console.log(`\n📊 Creating ${eventCount} pending events (WITHOUT batch updates)...`);
        const events: EventMessage[] = [];
        for (let i = 0; i < eventCount; i++) {
            const event = {
                messageId: `msg-nobatch-${i}`,
                type: 'benchmark.event',
                payload: { data: `test-${i}`, index: i },
                properties: { timestamp: Date.now() + i }
            };
            events.push(event);
            await storeWithoutBatch.saveEvent({ ...event, status: EventPublishStatus.PENDING });
        }

        console.log(`✅ ${eventCount} events created in store`);

        // Measure processing time
        console.log(`\n🚀 Starting processPendingEvents (individual updates)...`);
        const startTime = Date.now();
        
        await publisher.processPendingEvents({
            batchSize: 1000
        });

        const elapsed = Date.now() - startTime;
        const throughput = Math.round((eventCount / elapsed) * 1000);

        // Verify all events were processed
        let successCount = 0;
        for (const event of events) {
            const saved = await storeWithoutBatch.getEvent(event);
            if (saved?.status === EventPublishStatus.PUBLISHED) {
                successCount++;
            }
        }

        // Print results
        console.log(`\n📈 BENCHMARK RESULTS (WITHOUT batch updates):`);
        console.log(`   Events processed: ${successCount}/${eventCount}`);
        console.log(`   Time elapsed: ${elapsed}ms`);
        console.log(`   Throughput: ${throughput} msg/s`);
        console.log(`   Avg time per event: ${(elapsed / eventCount).toFixed(2)}ms`);
        console.log(`   Individual updates called: ${storeWithoutBatch.getCallCount('updateEventStatus')}`);
        console.log(`\n⚠️  Note: Without batch updates, performance may be lower`);

        expect(successCount).toBe(eventCount);
        expect(throughput).toBeGreaterThan(0);
    }, 60000);

    it('should compare WITH vs WITHOUT batch updates', async () => {
        const eventCount = 2000;

        // Test WITH batch updates
        console.log(`\n📊 Test 1: WITH batch updates`);
        publisher = new ResilientEventPublisher(config);
        (publisher as any).storeConnected = true;

        const events1: EventMessage[] = [];
        for (let i = 0; i < eventCount; i++) {
            const event = {
                messageId: `msg-with-${i}`,
                type: 'benchmark.event',
                payload: { data: `test-${i}` },
                properties: { timestamp: Date.now() + i }
            };
            events1.push(event);
            await mockStore.saveEvent({ ...event, status: EventPublishStatus.PENDING });
        }

        const startTime1 = Date.now();
        await publisher.processPendingEvents({ batchSize: 1000 });
        const elapsed1 = Date.now() - startTime1;
        const throughput1 = Math.round((eventCount / elapsed1) * 1000);

        console.log(`   ✅ Throughput: ${throughput1} msg/s (${elapsed1}ms)`);
        console.log(`   Batch updates: ${mockStore.getCallCount('batchUpdateEventStatus')}`);

        await publisher.disconnect();
        mockStore.clear();

        // Test WITHOUT batch updates
        console.log(`\n📊 Test 2: WITHOUT batch updates`);
        const storeWithoutBatch: any = {
            events: new Map<string, EventMessage>(),
            callCounts: new Map<string, number>(),
            async saveEvent(event: EventMessage): Promise<void> {
                this.events.set(event.messageId, { ...event });
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
                return this.events.get(event.messageId) || null;
            },
            async getPendingEvents(status: EventPublishStatus): Promise<EventMessage[]> {
                return (Array.from(this.events.values()) as EventMessage[]).filter(e => e.status === status);
            },
            getCallCount(method: string): number {
                return this.callCounts.get(method) || 0;
            }
        };

        const configWithoutBatch = { ...config, store: storeWithoutBatch };
        publisher = new ResilientEventPublisher(configWithoutBatch);
        (publisher as any).storeConnected = true;

        const events2: EventMessage[] = [];
        for (let i = 0; i < eventCount; i++) {
            const event = {
                messageId: `msg-without-${i}`,
                type: 'benchmark.event',
                payload: { data: `test-${i}` },
                properties: { timestamp: Date.now() + i }
            };
            events2.push(event);
            await storeWithoutBatch.saveEvent({ ...event, status: EventPublishStatus.PENDING });
        }

        const startTime2 = Date.now();
        await publisher.processPendingEvents({ batchSize: 1000 });
        const elapsed2 = Date.now() - startTime2;
        const throughput2 = Math.round((eventCount / elapsed2) * 1000);

        console.log(`   ✅ Throughput: ${throughput2} msg/s (${elapsed2}ms)`);
        console.log(`   Individual updates: ${storeWithoutBatch.getCallCount('updateEventStatus')}`);

        // Comparison
        const improvement = ((throughput1 - throughput2) / throughput2 * 100).toFixed(1);
        console.log(`\n🔥 COMPARISON:`);
        console.log(`   WITH batch:    ${throughput1} msg/s`);
        console.log(`   WITHOUT batch: ${throughput2} msg/s`);
        console.log(`   Improvement:   ${improvement}% faster with batch updates`);

        expect(throughput1).toBeGreaterThan(0);
        expect(throughput2).toBeGreaterThan(0);
    }, 90000);
});
