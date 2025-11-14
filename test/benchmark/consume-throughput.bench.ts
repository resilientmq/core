import { ResilientEventPublisher } from '../../src/resilience/resilient-event-publisher';
import { ResilientConsumer } from '../../src/resilience/resilient-consumer';
import { TestContainersManager } from '../utils/test-containers';
import { PublisherConfigBuilder, ConsumerConfigBuilder } from '../utils/test-data-builders';
import { createTestEvent } from '../fixtures/events';
import { Metrics } from '../utils/metrics-collector';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Benchmark: Consumption Throughput
 * 
 * Measures the throughput of consuming messages from RabbitMQ.
 * Pre-publishes 1000 messages, then measures consumption time.
 * Executes 5 iterations and calculates statistics.
 * 
 * Requirements: 4.2, 4.8
 */
describe('Benchmark: Consume Throughput', () => {
    let containerManager: TestContainersManager;
    let connectionUrl: string;
    let publisher: ResilientEventPublisher;
    
    const ITERATIONS = 5;
    const MESSAGES_PER_ITERATION = 1000;
    const results: Metrics[] = [];

    beforeAll(async () => {
        // Start RabbitMQ container
        containerManager = new TestContainersManager();
        await containerManager.startRabbitMQ();
        connectionUrl = containerManager.getConnectionUrl();
    }, 120000);

    afterAll(async () => {
        // Stop containers
        await containerManager.stopAll();
        
        // Calculate statistics
        const throughputs = results.map(r => r.throughput);
        const latencies = results.map(r => r.latencyAvg);
        
        const avgThroughput = throughputs.reduce((sum, t) => sum + t, 0) / throughputs.length;
        const minThroughput = Math.min(...throughputs);
        const maxThroughput = Math.max(...throughputs);
        const stdDevThroughput = calculateStdDev(throughputs);
        
        const avgLatency = latencies.reduce((sum, l) => sum + l, 0) / latencies.length;
        const minLatency = Math.min(...latencies);
        const maxLatency = Math.max(...latencies);
        
        // Aggregate P95 and P99 from all iterations
        const allP95 = results.map(r => r.latencyP95);
        const allP99 = results.map(r => r.latencyP99);
        const avgP95 = allP95.reduce((sum, p) => sum + p, 0) / allP95.length;
        const avgP99 = allP99.reduce((sum, p) => sum + p, 0) / allP99.length;
        
        // Print summary to console
        console.log('\n' + '='.repeat(60));
        console.log('CONSUME THROUGHPUT BENCHMARK RESULTS');
        console.log('='.repeat(60));
        console.log(`Iterations: ${ITERATIONS}`);
        console.log(`Messages per iteration: ${MESSAGES_PER_ITERATION}`);
        console.log(`Total messages: ${ITERATIONS * MESSAGES_PER_ITERATION}`);
        console.log('-'.repeat(60));
        console.log('THROUGHPUT (messages/second):');
        console.log(`  Average: ${avgThroughput.toFixed(2)} msg/s`);
        console.log(`  Min:     ${minThroughput.toFixed(2)} msg/s`);
        console.log(`  Max:     ${maxThroughput.toFixed(2)} msg/s`);
        console.log(`  StdDev:  ${stdDevThroughput.toFixed(2)} msg/s`);
        console.log('-'.repeat(60));
        console.log('LATENCY (milliseconds):');
        console.log(`  Average: ${avgLatency.toFixed(2)} ms`);
        console.log(`  Min:     ${minLatency.toFixed(2)} ms`);
        console.log(`  Max:     ${maxLatency.toFixed(2)} ms`);
        console.log(`  P95:     ${avgP95.toFixed(2)} ms`);
        console.log(`  P99:     ${avgP99.toFixed(2)} ms`);
        console.log('='.repeat(60) + '\n');
        
        // Export results to JSON
        const outputDir = path.join(__dirname, '../../test-results');
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }
        
        const benchmarkResults = {
            benchmark: 'consume-throughput',
            timestamp: new Date().toISOString(),
            configuration: {
                iterations: ITERATIONS,
                messagesPerIteration: MESSAGES_PER_ITERATION,
                totalMessages: ITERATIONS * MESSAGES_PER_ITERATION
            },
            summary: {
                throughput: {
                    average: avgThroughput,
                    min: minThroughput,
                    max: maxThroughput,
                    stdDev: stdDevThroughput,
                    unit: 'messages/second'
                },
                latency: {
                    average: avgLatency,
                    min: minLatency,
                    max: maxLatency,
                    p95: avgP95,
                    p99: avgP99,
                    unit: 'milliseconds'
                }
            },
            iterations: results.map((r, i) => ({
                iteration: i + 1,
                ...r
            }))
        };
        
        const outputPath = path.join(outputDir, 'benchmark-consume-throughput.json');
        fs.writeFileSync(outputPath, JSON.stringify(benchmarkResults, null, 2), 'utf-8');
        console.log(`Results exported to: ${outputPath}\n`);
    }, 30000);

    beforeEach(async () => {
        // Create publisher for each iteration
        const config = new PublisherConfigBuilder()
            .withConnection(connectionUrl)
            .withQueue('benchmark.consume.throughput')
            .withInstantPublish(true)
            .build();
        
        publisher = new ResilientEventPublisher(config);
    });

    afterEach(async () => {
        // Cleanup publisher
        if (publisher) {
            await publisher.disconnect();
        }
    });

    // Run 5 iterations
    for (let iteration = 1; iteration <= ITERATIONS; iteration++) {
        it(`iteration ${iteration}/${ITERATIONS}`, async () => {
            // Pre-publish messages
            console.log(`\nIteration ${iteration}: Publishing ${MESSAGES_PER_ITERATION} messages...`);
            for (let i = 0; i < MESSAGES_PER_ITERATION; i++) {
                const event = createTestEvent(
                    { iteration, index: i, timestamp: Date.now() },
                    'benchmark.consume.throughput'
                );
                await publisher.publish(event);
            }
            
            // Setup consumer and measure consumption time
            let messagesConsumed = 0;
            const latencies: number[] = [];
            const startTime = Date.now();
            
            const consumerConfig = new ConsumerConfigBuilder()
                .withConnection(connectionUrl)
                .withQueue('benchmark.consume.throughput')
                .withPrefetch(100)
                .withEventHandler('benchmark.consume.throughput', async (payload: any) => {
                    const messageStartTime = payload.timestamp;
                    const latency = Date.now() - messageStartTime;
                    latencies.push(latency);
                    messagesConsumed++;
                })
                .build();
            
            const consumer = new ResilientConsumer(consumerConfig);
            
            // Start consuming
            await consumer.start();
            
            // Wait for all messages to be consumed
            const maxWaitTime = 30000; // 30 seconds max
            const checkInterval = 100;
            let waited = 0;
            
            while (messagesConsumed < MESSAGES_PER_ITERATION && waited < maxWaitTime) {
                await new Promise(resolve => setTimeout(resolve, checkInterval));
                waited += checkInterval;
            }
            
            // Wait a bit more to ensure all processing is complete
            await new Promise(resolve => setTimeout(resolve, 1000));
            
            await consumer.stop();
            
            const endTime = Date.now();
            const duration = endTime - startTime;
            
            // Calculate metrics
            const throughput = messagesConsumed > 0 ? (messagesConsumed / duration) * 1000 : 0;
            const sortedLatencies = [...latencies].sort((a, b) => a - b);
            const latencyAvg = latencies.length > 0 
                ? latencies.reduce((sum, lat) => sum + lat, 0) / latencies.length 
                : 0;
            const latencyP50 = calculatePercentile(sortedLatencies, 50);
            const latencyP95 = calculatePercentile(sortedLatencies, 95);
            const latencyP99 = calculatePercentile(sortedLatencies, 99);
            
            const metrics: Metrics = {
                throughput,
                latencyAvg,
                latencyP50,
                latencyP95,
                latencyP99,
                memoryUsageMB: process.memoryUsage().heapUsed / 1024 / 1024,
                cpuUsagePercent: 0,
                errorRate: 0,
                totalMessages: messagesConsumed,
                totalErrors: 0,
                duration
            };
            
            results.push(metrics);
            
            // Log iteration results
            console.log(`Iteration ${iteration} completed:`);
            console.log(`  Messages consumed: ${messagesConsumed}`);
            console.log(`  Throughput: ${metrics.throughput.toFixed(2)} msg/s`);
            console.log(`  Avg Latency: ${metrics.latencyAvg.toFixed(2)} ms`);
            console.log(`  P95 Latency: ${metrics.latencyP95.toFixed(2)} ms`);
            console.log(`  P99 Latency: ${metrics.latencyP99.toFixed(2)} ms`);
            
            // Verify all messages were consumed
            expect(messagesConsumed).toBe(MESSAGES_PER_ITERATION);
        }, 120000); // 2 minute timeout per iteration
    }
});

/**
 * Calculates standard deviation of an array of numbers.
 */
function calculateStdDev(values: number[]): number {
    if (values.length === 0) return 0;
    
    const mean = values.reduce((sum, val) => sum + val, 0) / values.length;
    const squaredDiffs = values.map(val => Math.pow(val - mean, 2));
    const variance = squaredDiffs.reduce((sum, val) => sum + val, 0) / values.length;
    
    return Math.sqrt(variance);
}

/**
 * Calculates a percentile value from sorted latencies.
 */
function calculatePercentile(sortedLatencies: number[], percentile: number): number {
    if (sortedLatencies.length === 0) {
        return 0;
    }

    const index = Math.ceil((percentile / 100) * sortedLatencies.length) - 1;
    return sortedLatencies[Math.max(0, index)];
}
