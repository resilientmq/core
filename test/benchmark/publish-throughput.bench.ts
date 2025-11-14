import { ResilientEventPublisher } from '../../src/resilience/resilient-event-publisher';
import { TestContainersManager } from '../utils/test-containers';
import { PublisherConfigBuilder } from '../utils/test-data-builders';
import { createTestEvent } from '../fixtures/events';
import { MetricsCollector, Metrics } from '../utils/metrics-collector';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Benchmark: Publication Throughput
 * 
 * Measures the throughput of publishing messages to RabbitMQ.
 * Executes 5 iterations of 1000 messages each and calculates statistics.
 * 
 * Requirements: 4.1, 4.8
 */
describe('Benchmark: Publish Throughput', () => {
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
        console.log('PUBLISH THROUGHPUT BENCHMARK RESULTS');
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
            benchmark: 'publish-throughput',
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
        
        const outputPath = path.join(outputDir, 'benchmark-publish-throughput.json');
        fs.writeFileSync(outputPath, JSON.stringify(benchmarkResults, null, 2), 'utf-8');
        console.log(`Results exported to: ${outputPath}\n`);
    }, 30000);

    beforeEach(async () => {
        // Create publisher for each iteration
        const config = new PublisherConfigBuilder()
            .withConnection(connectionUrl)
            .withQueue('benchmark.publish.throughput')
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
            const collector = new MetricsCollector();
            collector.start();
            
            // Publish messages and measure latency
            for (let i = 0; i < MESSAGES_PER_ITERATION; i++) {
                const event = createTestEvent(
                    { iteration, index: i, timestamp: Date.now() },
                    'benchmark.publish.throughput'
                );
                
                const startTime = Date.now();
                await publisher.publish(event);
                const latency = Date.now() - startTime;
                
                collector.recordMessage(latency);
            }
            
            const metrics = collector.stop();
            results.push(metrics);
            
            // Log iteration results
            console.log(`\nIteration ${iteration} completed:`);
            console.log(`  Throughput: ${metrics.throughput.toFixed(2)} msg/s`);
            console.log(`  Avg Latency: ${metrics.latencyAvg.toFixed(2)} ms`);
            console.log(`  P95 Latency: ${metrics.latencyP95.toFixed(2)} ms`);
            console.log(`  P99 Latency: ${metrics.latencyP99.toFixed(2)} ms`);
            
            // Verify no errors occurred
            expect(metrics.errorRate).toBe(0);
            expect(metrics.totalMessages).toBe(MESSAGES_PER_ITERATION);
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
