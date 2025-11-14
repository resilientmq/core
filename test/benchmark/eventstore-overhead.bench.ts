import { ResilientEventPublisher } from '../../src/resilience/resilient-event-publisher';
import { TestContainersManager } from '../utils/test-containers';
import { PublisherConfigBuilder } from '../utils/test-data-builders';
import { createTestEvent } from '../fixtures/events';
import { EventStoreMock } from '../utils/event-store-mock';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Benchmark: EventStore Overhead
 * 
 * Measures the performance overhead of using EventStore.
 * Compares publish time with and without store.
 * Calculates percentage overhead.
 * 
 * Requirements: 4.4, 4.8
 */
describe('Benchmark: EventStore Overhead', () => {
    let containerManager: TestContainersManager;
    let connectionUrl: string;
    
    const MESSAGES_PER_TEST = 1000;
    const ITERATIONS = 3;
    const results: any = {
        withoutStore: [],
        withStore: []
    };

    beforeAll(async () => {
        // Start RabbitMQ container
        containerManager = new TestContainersManager();
        await containerManager.startRabbitMQ();
        connectionUrl = containerManager.getConnectionUrl();
    }, 120000);

    afterAll(async () => {
        // Stop containers
        await containerManager.stopAll();
        
        // Calculate averages
        const avgWithoutStore = results.withoutStore.reduce((sum: number, t: number) => sum + t, 0) / results.withoutStore.length;
        const avgWithStore = results.withStore.reduce((sum: number, t: number) => sum + t, 0) / results.withStore.length;
        const overhead = ((avgWithStore - avgWithoutStore) / avgWithoutStore) * 100;
        
        // Print summary to console
        console.log('\n' + '='.repeat(60));
        console.log('EVENTSTORE OVERHEAD BENCHMARK RESULTS');
        console.log('='.repeat(60));
        console.log(`Messages per test: ${MESSAGES_PER_TEST}`);
        console.log(`Iterations: ${ITERATIONS}`);
        console.log('-'.repeat(60));
        console.log('WITHOUT STORE:');
        console.log(`  Average time: ${avgWithoutStore.toFixed(2)} ms`);
        console.log(`  Throughput: ${((MESSAGES_PER_TEST / avgWithoutStore) * 1000).toFixed(2)} msg/s`);
        console.log('-'.repeat(60));
        console.log('WITH STORE:');
        console.log(`  Average time: ${avgWithStore.toFixed(2)} ms`);
        console.log(`  Throughput: ${((MESSAGES_PER_TEST / avgWithStore) * 1000).toFixed(2)} msg/s`);
        console.log('-'.repeat(60));
        console.log('OVERHEAD:');
        console.log(`  Absolute: ${(avgWithStore - avgWithoutStore).toFixed(2)} ms`);
        console.log(`  Percentage: ${overhead.toFixed(2)}%`);
        console.log('='.repeat(60) + '\n');
        
        // Export results to JSON
        const outputDir = path.join(__dirname, '../../test-results');
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }
        
        const benchmarkResults = {
            benchmark: 'eventstore-overhead',
            timestamp: new Date().toISOString(),
            configuration: {
                messagesPerTest: MESSAGES_PER_TEST,
                iterations: ITERATIONS
            },
            summary: {
                withoutStore: {
                    averageTime: avgWithoutStore,
                    throughput: (MESSAGES_PER_TEST / avgWithoutStore) * 1000,
                    unit: 'milliseconds'
                },
                withStore: {
                    averageTime: avgWithStore,
                    throughput: (MESSAGES_PER_TEST / avgWithStore) * 1000,
                    unit: 'milliseconds'
                },
                overhead: {
                    absolute: avgWithStore - avgWithoutStore,
                    percentage: overhead,
                    unit: 'milliseconds'
                }
            },
            iterations: {
                withoutStore: results.withoutStore,
                withStore: results.withStore
            }
        };
        
        const outputPath = path.join(outputDir, 'benchmark-eventstore-overhead.json');
        fs.writeFileSync(outputPath, JSON.stringify(benchmarkResults, null, 2), 'utf-8');
        console.log(`Results exported to: ${outputPath}\n`);
    }, 30000);

    describe('Without EventStore', () => {
        for (let iteration = 1; iteration <= ITERATIONS; iteration++) {
            it(`iteration ${iteration}/${ITERATIONS}`, async () => {
                const config = new PublisherConfigBuilder()
                    .withConnection(connectionUrl)
                    .withQueue('benchmark.store.overhead.nostore')
                    .withInstantPublish(true)
                    .build();
                
                const publisher = new ResilientEventPublisher(config);
                
                const startTime = Date.now();
                
                for (let i = 0; i < MESSAGES_PER_TEST; i++) {
                    const event = createTestEvent(
                        { iteration, index: i },
                        'benchmark.store.overhead'
                    );
                    await publisher.publish(event);
                }
                
                const duration = Date.now() - startTime;
                results.withoutStore.push(duration);
                
                await publisher.disconnect();
                
                console.log(`Without store - Iteration ${iteration}: ${duration}ms (${((MESSAGES_PER_TEST / duration) * 1000).toFixed(2)} msg/s)`);
                
                expect(duration).toBeGreaterThan(0);
            }, 120000);
        }
    });

    describe('With EventStore', () => {
        for (let iteration = 1; iteration <= ITERATIONS; iteration++) {
            it(`iteration ${iteration}/${ITERATIONS}`, async () => {
                const store = new EventStoreMock();
                
                const config = new PublisherConfigBuilder()
                    .withConnection(connectionUrl)
                    .withQueue('benchmark.store.overhead.withstore')
                    .withStore(store)
                    .withInstantPublish(true)
                    .build();
                
                const publisher = new ResilientEventPublisher(config);
                
                const startTime = Date.now();
                
                for (let i = 0; i < MESSAGES_PER_TEST; i++) {
                    const event = createTestEvent(
                        { iteration, index: i },
                        'benchmark.store.overhead'
                    );
                    await publisher.publish(event);
                }
                
                const duration = Date.now() - startTime;
                results.withStore.push(duration);
                
                await publisher.disconnect();
                
                console.log(`With store - Iteration ${iteration}: ${duration}ms (${((MESSAGES_PER_TEST / duration) * 1000).toFixed(2)} msg/s)`);
                
                expect(duration).toBeGreaterThan(0);
            }, 120000);
        }
    });
});
