import * as fs from 'fs';
import * as path from 'path';

/**
 * Interface for stress test metrics summary.
 */
export interface StressTestSummary {
    testName: string;
    timestamp: string;
    metrics: {
        throughput: number;
        latencyAvg: number;
        latencyP50: number;
        latencyP95: number;
        latencyP99: number;
        memoryUsageMB: number;
        cpuUsagePercent: number;
        errorRate: number;
        totalMessages: number;
        totalErrors: number;
        duration: number;
    };
    customMetrics?: Record<string, any>;
}

/**
 * Generates a consolidated summary of all stress test results.
 */
export class StressMetricsSummary {
    private summaries: StressTestSummary[] = [];

    /**
     * Adds a test result to the summary.
     */
    addTestResult(summary: StressTestSummary): void {
        this.summaries.push(summary);
    }

    /**
     * Loads metrics from a JSON file and adds to summary.
     */
    loadFromFile(testName: string, filepath: string): void {
        try {
            if (fs.existsSync(filepath)) {
                const data = fs.readFileSync(filepath, 'utf-8');
                const metrics = JSON.parse(data);
                
                this.addTestResult({
                    testName,
                    timestamp: new Date().toISOString(),
                    metrics
                });
            }
        } catch (error) {
            console.error(`Failed to load metrics from ${filepath}:`, error);
        }
    }

    /**
     * Generates and exports a consolidated summary report.
     */
    exportSummary(outputPath: string = './test-results/stress-metrics-summary.json'): void {
        const summary = {
            generatedAt: new Date().toISOString(),
            totalTests: this.summaries.length,
            tests: this.summaries,
            aggregates: this.calculateAggregates()
        };

        // Ensure directory exists
        const dir = path.dirname(outputPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        // Write summary to file
        fs.writeFileSync(outputPath, JSON.stringify(summary, null, 2), 'utf-8');
        
        // Also print to console
        this.printConsoleSummary(summary);
    }

    /**
     * Calculates aggregate statistics across all tests.
     */
    private calculateAggregates() {
        if (this.summaries.length === 0) {
            return null;
        }

        const totalMessages = this.summaries.reduce((sum, s) => sum + s.metrics.totalMessages, 0);
        const totalErrors = this.summaries.reduce((sum, s) => sum + s.metrics.totalErrors, 0);
        const avgThroughput = this.summaries.reduce((sum, s) => sum + s.metrics.throughput, 0) / this.summaries.length;
        const avgLatency = this.summaries.reduce((sum, s) => sum + s.metrics.latencyAvg, 0) / this.summaries.length;
        const avgErrorRate = this.summaries.reduce((sum, s) => sum + s.metrics.errorRate, 0) / this.summaries.length;
        const maxMemoryUsage = Math.max(...this.summaries.map(s => s.metrics.memoryUsageMB));
        const avgCpuUsage = this.summaries.reduce((sum, s) => sum + s.metrics.cpuUsagePercent, 0) / this.summaries.length;

        return {
            totalMessages,
            totalErrors,
            avgThroughput,
            avgLatency,
            avgErrorRate,
            maxMemoryUsage,
            avgCpuUsage
        };
    }

    /**
     * Prints a formatted summary to console.
     */
    private printConsoleSummary(summary: any): void {
        console.log('\n╔════════════════════════════════════════════════════════════╗');
        console.log('║         STRESS TESTS - CONSOLIDATED SUMMARY                ║');
        console.log('╚════════════════════════════════════════════════════════════╝\n');
        
        console.log(`Generated: ${summary.generatedAt}`);
        console.log(`Total Tests: ${summary.totalTests}\n`);

        if (summary.aggregates) {
            console.log('─────────────────────────────────────────────────────────────');
            console.log('AGGREGATE METRICS');
            console.log('─────────────────────────────────────────────────────────────');
            console.log(`Total Messages Processed: ${summary.aggregates.totalMessages.toLocaleString()}`);
            console.log(`Total Errors: ${summary.aggregates.totalErrors.toLocaleString()}`);
            console.log(`Average Throughput: ${summary.aggregates.avgThroughput.toFixed(2)} msg/s`);
            console.log(`Average Latency: ${summary.aggregates.avgLatency.toFixed(2)} ms`);
            console.log(`Average Error Rate: ${summary.aggregates.avgErrorRate.toFixed(2)}%`);
            console.log(`Max Memory Usage: ${summary.aggregates.maxMemoryUsage.toFixed(2)} MB`);
            console.log(`Average CPU Usage: ${summary.aggregates.avgCpuUsage.toFixed(2)}%\n`);
        }

        console.log('─────────────────────────────────────────────────────────────');
        console.log('INDIVIDUAL TEST RESULTS');
        console.log('─────────────────────────────────────────────────────────────\n');

        summary.tests.forEach((test: StressTestSummary, index: number) => {
            console.log(`${index + 1}. ${test.testName}`);
            console.log(`   Throughput: ${test.metrics.throughput.toFixed(2)} msg/s`);
            console.log(`   Latency (Avg/P95/P99): ${test.metrics.latencyAvg.toFixed(2)}/${test.metrics.latencyP95.toFixed(2)}/${test.metrics.latencyP99.toFixed(2)} ms`);
            console.log(`   Error Rate: ${test.metrics.errorRate.toFixed(2)}%`);
            console.log(`   Messages: ${test.metrics.totalMessages.toLocaleString()} (${test.metrics.totalErrors} errors)`);
            console.log(`   Duration: ${(test.metrics.duration / 1000).toFixed(2)}s\n`);
        });

        console.log('═════════════════════════════════════════════════════════════\n');
    }

    /**
     * Clears all summaries.
     */
    clear(): void {
        this.summaries = [];
    }
}

/**
 * Helper function to generate a consolidated summary from all stress test results.
 */
export function generateStressTestsSummary(): void {
    const summary = new StressMetricsSummary();
    const resultsDir = './test-results';

    // Load all stress test results
    const testFiles = [
        { name: 'High Volume Publishing', file: 'stress-high-volume-publish.json' },
        { name: 'High Speed Consumption', file: 'stress-high-speed-consume.json' }
    ];

    testFiles.forEach(({ name, file }) => {
        const filepath = path.join(resultsDir, file);
        summary.loadFromFile(name, filepath);
    });

    // Export consolidated summary
    summary.exportSummary();
}
