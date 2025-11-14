import { ResilientEventPublisher } from '../../src/resilience/resilient-event-publisher';
import { ResilientConsumer } from '../../src/resilience/resilient-consumer';
import { TestContainersManager } from '../utils/test-containers';
import { PublisherConfigBuilder, ConsumerConfigBuilder } from '../utils/test-data-builders';
import { createTestEvent } from '../fixtures/events';
import { Middleware } from '../../src/types/resilience/middleware';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Benchmark: Middleware Impact
 * 
 * Measures the performance impact of middleware on message processing.
 * Tests with 0, 1, 3, and 5 middleware functions.
 * Calculates throughput degradation per middleware.
 * 
 * Requirements: 4.5, 4.8
 */
describe('Benchmark: Middleware Impact', () => {
    let containerManager: TestContainersManager;
    let connectionUrl: string;
    
    const MESSAGES_PER_TEST = 500;
    const MIDDLEWARE_COUNTS = [0, 1, 3, 5];
    const results: any[] = [];

    beforeAll(async () => {
        // Start RabbitMQ container
        containerManager = new TestContainersManager();
        await containerManager.startRabbitMQ();
        connectionUrl = containerManager.getConnectionUrl();
    }, 120000);

    afterAll(async () => {
        // Stop containers
        await containerManager.stopAll();
        
        // Calculate degradation
        const baselineThroughput = results.find(r => r.middlewareCount === 0)?.throughput || 0;
        
        // Print summary to console
        console.log('\n' + '='.repeat(60));
        console.log('MIDDLEWARE IMPACT BENCHMARK RESULTS');
        console.log('='.repeat(60));
        console.log(`Messages per test: ${MESSAGES_PER_TEST}`);
        console.log('-'.repeat(60));
        
        for (const result of results) {
            const degradation = baselineThroughput > 0 
                ? ((baselineThroughput - result.throughput) / baselineThroughput) * 100 
                : 0;
            
            console.log(`\nMiddleware count: ${result.middlewareCount}`);
            console.log(`  Throughput: ${result.throughput.toFixed(2)} msg/s`);
            console.log(`  Avg latency: ${result.avgLatency.toFixed(2)} ms`);
            console.log(`  Total time: ${result.totalTime.toFixed(2)} ms`);
            if (result.middlewareCount > 0) {
                console.log(`  Degradation: ${degradation.toFixed(2)}%`);
                console.log(`  Per middleware: ${(degradation / result.middlewareCount).toFixed(2)}%`);
            }
        }
        
        console.log('\n' + '='.repeat(60) + '\n');
        
        // Export results to JSON
        const outputDir = path.join(__dirname, '../../test-results');
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }
        
        const benchmarkResults = {
            benchmark: 'middleware-impact',
            timestamp: new Date().toISOString(),
            configuration: {
                messagesPerTest: MESSAGES_PER_TEST,
                middlewareCounts: MIDDLEWARE_COUNTS
            },
            baseline: {
                throughput: baselineThroughput,
                unit: 'messages/second'
            },
            results: results.map(r => {
                const degradation = baselineThroughput > 0 
                    ? ((baselineThroughput - r.throughput) / baselineThroughput) * 100 
                    : 0;
                const perMiddleware = r.middlewareCount > 0 ? degradation / r.middlewareCount : 0;
                
                return {
                    ...r,
                    degradation: {
                        total: degradation,
                        perMiddleware,
                        unit: 'percentage'
                    }
                };
            })
        };
        
        const outputPath = path.join(outputDir, 'benchmark-middleware-impact.json');
        fs.writeFileSync(outputPath, JSON.stringify(benchmarkResults, null, 2), 'utf-8');
        console.log(`Results exported to: ${outputPath}\n`);
    }, 30000);

    // Test each middleware count
    for (const middlewareCount of MIDDLEWARE_COUNTS) {
        it(`with ${middlewareCount} middleware`, async () => {
            const queueName = `benchmark.middleware.${middlewareCount}`;
            
            // Create middleware functions
            const middleware: Middleware[] = [];
            for (let i = 0; i < middlewareCount; i++) {
                middleware.push(async (event: any, next: () => Promise<void>) => {
                    // Simple middleware that does minimal processing
                    await next();
                });
            }
            
            // Setup consumer with middleware
            let messagesReceived = 0;
            const latencies: number[] = [];
            
            const consumerConfig = new ConsumerConfigBuilder()
                .withConnection(connectionUrl)
                .withQueue(queueName)
                .withPrefetch(10)
                .withMiddleware(middleware)
                .withEventHandler('benchmark.middleware', async (payload: any) => {
                    const latency = Date.now() - payload.timestamp;
                    latencies.push(latency);
                    messagesReceived++;
                })
                .build();
            
            const consumer = new ResilientConsumer(consumerConfig);
            await consumer.start();
            
            // Setup publisher
            const publisherConfig = new PublisherConfigBuilder()
                .withConnection(connectionUrl)
                .withQueue(queueName)
                .withInstantPublish(true)
                .build();
            
            const publisher = new ResilientEventPublisher(publisherConfig);
            
            // Publish messages
            const startTime = Date.now();
            
            for (let i = 0; i < MESSAGES_PER_TEST; i++) {
                const event = createTestEvent(
                    { 
                        middlewareCount, 
                        index: i,
                        timestamp: Date.now()
                    },
                    'benchmark.middleware'
                );
                await publisher.publish(event);
            }
            
            // Wait for all messages to be consumed
            const maxWaitTime = 30000;
            const checkInterval = 100;
            let waited = 0;
            
            while (messagesReceived < MESSAGES_PER_TEST && waited < maxWaitTime) {
                await new Promise(resolve => setTimeout(resolve, checkInterval));
                waited += checkInterval;
            }
            
            await new Promise(resolve => setTimeout(resolve, 500));
            
            const endTime = Date.now();
            const totalTime = endTime - startTime;
            
            await consumer.stop();
            await publisher.disconnect();
            
            // Calculate metrics
            const throughput = messagesReceived > 0 ? (messagesReceived / totalTime) * 1000 : 0;
            const avgLatency = latencies.length > 0 
                ? latencies.reduce((sum, l) => sum + l, 0) / latencies.length 
                : 0;
            
            const result = {
                middlewareCount,
                totalMessages: messagesReceived,
                totalTime,
                throughput,
                avgLatency
            };
            
            results.push(result);
            
            console.log(`\nMiddleware count ${middlewareCount}:`);
            console.log(`  Messages: ${messagesReceived}`);
            console.log(`  Throughput: ${throughput.toFixed(2)} msg/s`);
            console.log(`  Avg latency: ${avgLatency.toFixed(2)} ms`);
            
            expect(messagesReceived).toBe(MESSAGES_PER_TEST);
        }, 120000);
    }
});
