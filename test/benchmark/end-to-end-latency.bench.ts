import { ResilientEventPublisher } from '../../src/resilience/resilient-event-publisher';
import { ResilientConsumer } from '../../src/resilience/resilient-consumer';
import { EventMessage } from '../../src/types';
import { TestContainersManager } from '../utils/test-containers';
import { PublisherConfigBuilder, ConsumerConfigBuilder } from '../utils/test-data-builders';
import { EventStoreMock } from '../utils/event-store-mock';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Benchmark: End-to-End Latency
 * 
 * Measures latency from publish to handler completion.
 * Tests with different payload sizes and with/without persistence.
 * Calculates P50, P95, P99 latencies.
 * 
 * Requirements: 4.3, 4.8
 */
describe('Benchmark: End-to-End Latency', () => {
    let containerManager: TestContainersManager;
    let connectionUrl: string;
    
    const MESSAGES_PER_TEST = 100;
    const PAYLOAD_SIZES = [
        { name: 'small', size: 100 },      // ~100 bytes
        { name: 'medium', size: 1000 },    // ~1KB
        { name: 'large', size: 10000 }     // ~10KB
    ];
    
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
        
        // Print summary to console
        console.log('\n' + '='.repeat(60));
        console.log('END-TO-END LATENCY BENCHMARK RESULTS');
        console.log('='.repeat(60));
        
        for (const result of results) {
            console.log(`\n${result.scenario.toUpperCase()}:`);
            console.log(`  Payload size: ${result.payloadSize} bytes`);
            console.log(`  Persistence: ${result.withPersistence ? 'enabled' : 'disabled'}`);
            console.log(`  Messages: ${result.totalMessages}`);
            console.log(`  Latency P50: ${result.latencyP50.toFixed(2)} ms`);
            console.log(`  Latency P95: ${result.latencyP95.toFixed(2)} ms`);
            console.log(`  Latency P99: ${result.latencyP99.toFixed(2)} ms`);
            console.log(`  Latency Avg: ${result.latencyAvg.toFixed(2)} ms`);
            console.log(`  Latency Min: ${result.latencyMin.toFixed(2)} ms`);
            console.log(`  Latency Max: ${result.latencyMax.toFixed(2)} ms`);
        }
        
        console.log('\n' + '='.repeat(60) + '\n');
        
        // Export results to JSON
        const outputDir = path.join(__dirname, '../../test-results');
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }
        
        const benchmarkResults = {
            benchmark: 'end-to-end-latency',
            timestamp: new Date().toISOString(),
            configuration: {
                messagesPerTest: MESSAGES_PER_TEST,
                payloadSizes: PAYLOAD_SIZES
            },
            results
        };
        
        const outputPath = path.join(outputDir, 'benchmark-end-to-end-latency.json');
        fs.writeFileSync(outputPath, JSON.stringify(benchmarkResults, null, 2), 'utf-8');
        console.log(`Results exported to: ${outputPath}\n`);
    }, 30000);

    // Test each payload size with and without persistence
    for (const payloadConfig of PAYLOAD_SIZES) {
        describe(`Payload size: ${payloadConfig.name} (~${payloadConfig.size} bytes)`, () => {
            
            it('without persistence', async () => {
                const latencies: number[] = [];
                const queueName = `benchmark.e2e.${payloadConfig.name}.nopersist`;
                
                // Setup consumer
                let messagesReceived = 0;
                const consumerConfig = new ConsumerConfigBuilder()
                    .withConnection(connectionUrl)
                    .withQueue(queueName)
                    .withPrefetch(10)
                    .withEventHandler('test.e2e', async (event: EventMessage) => {
                        const latency = Date.now() - event.payload.publishTime;
                        latencies.push(latency);
                        messagesReceived++;
                    })
                    .build();
                
                const consumer = new ResilientConsumer(consumerConfig);
                await consumer.start();
                
                // Give consumer time to fully initialize
                await new Promise(resolve => setTimeout(resolve, 2000));
                
                // Setup publisher without store
                const publisherConfig = new PublisherConfigBuilder()
                    .withConnection(connectionUrl)
                    .withQueue(queueName)
                    .withInstantPublish(true)
                    .build();
                
                const publisher = new ResilientEventPublisher(publisherConfig);
                
                // Publish messages
                for (let i = 0; i < MESSAGES_PER_TEST; i++) {
                    const payload = {
                        publishTime: Date.now(),
                        index: i,
                        data: 'x'.repeat(payloadConfig.size)
                    };
                    
                    await publisher.publish({
                        messageId: `e2e-${payloadConfig.name}-nopersist-${i}`,
                        type: 'test.e2e',
                        payload,
                        properties: {}
                    });
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
                
                await consumer.stop();
                await publisher.disconnect();
                
                // Calculate statistics
                const sortedLatencies = [...latencies].sort((a, b) => a - b);
                const result = {
                    scenario: `${payloadConfig.name}_without_persistence`,
                    payloadSize: payloadConfig.size,
                    withPersistence: false,
                    totalMessages: messagesReceived,
                    latencyP50: calculatePercentile(sortedLatencies, 50),
                    latencyP95: calculatePercentile(sortedLatencies, 95),
                    latencyP99: calculatePercentile(sortedLatencies, 99),
                    latencyAvg: sortedLatencies.reduce((sum, l) => sum + l, 0) / sortedLatencies.length,
                    latencyMin: Math.min(...sortedLatencies),
                    latencyMax: Math.max(...sortedLatencies)
                };
                
                results.push(result);
                
                expect(messagesReceived).toBe(MESSAGES_PER_TEST);
            }, 120000);
            
            it('with persistence', async () => {
                const latencies: number[] = [];
                const queueName = `benchmark.e2e.${payloadConfig.name}.persist`;
                const store = new EventStoreMock();
                
                // Setup consumer with store
                let messagesReceived = 0;
                const consumerConfig = new ConsumerConfigBuilder()
                    .withConnection(connectionUrl)
                    .withQueue(queueName)
                    .withPrefetch(10)
                    .withStore(store)
                    .withEventHandler('test.e2e', async (event: EventMessage) => {
                        const latency = Date.now() - event.payload.publishTime;
                        latencies.push(latency);
                        messagesReceived++;
                    })
                    .build();
                
                const consumer = new ResilientConsumer(consumerConfig);
                await consumer.start();
                
                // Give consumer time to fully initialize
                await new Promise(resolve => setTimeout(resolve, 2000));
                
                // Setup publisher WITHOUT store (to avoid duplicate detection issues)
                // The consumer has the store, which is what we want to benchmark
                const publisherConfig = new PublisherConfigBuilder()
                    .withConnection(connectionUrl)
                    .withQueue(queueName)
                    .withInstantPublish(true)
                    .build();
                
                const publisher = new ResilientEventPublisher(publisherConfig);
                
                // Publish messages
                for (let i = 0; i < MESSAGES_PER_TEST; i++) {
                    const payload = {
                        publishTime: Date.now(),
                        index: i,
                        data: 'x'.repeat(payloadConfig.size)
                    };
                    
                    await publisher.publish({
                        messageId: `e2e-${payloadConfig.name}-persist-${i}`,
                        type: 'test.e2e',
                        payload,
                        properties: {}
                    });
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
                
                await consumer.stop();
                await publisher.disconnect();
                
                // Calculate statistics
                const sortedLatencies = [...latencies].sort((a, b) => a - b);
                const result = {
                    scenario: `${payloadConfig.name}_with_persistence`,
                    payloadSize: payloadConfig.size,
                    withPersistence: true,
                    totalMessages: messagesReceived,
                    latencyP50: calculatePercentile(sortedLatencies, 50),
                    latencyP95: calculatePercentile(sortedLatencies, 95),
                    latencyP99: calculatePercentile(sortedLatencies, 99),
                    latencyAvg: sortedLatencies.reduce((sum, l) => sum + l, 0) / sortedLatencies.length,
                    latencyMin: Math.min(...sortedLatencies),
                    latencyMax: Math.max(...sortedLatencies)
                };
                
                results.push(result);
                
                expect(messagesReceived).toBe(MESSAGES_PER_TEST);
            }, 120000);
        });
    }
});

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
