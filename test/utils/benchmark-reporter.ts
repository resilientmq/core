import * as fs from 'fs';
import * as path from 'path';

/**
 * Consolidated benchmark report containing all benchmark results
 */
export interface ConsolidatedReport {
    timestamp: string;
    version: string;
    benchmarks: {
        [key: string]: any;
    };
    summary: {
        totalBenchmarks: number;
        totalTests: number;
        totalMessages: number;
        averageThroughput?: number;
        averageLatency?: number;
    };
}

/**
 * Utility for generating consolidated benchmark reports.
 * Aggregates individual benchmark results into a single report.
 */
export class BenchmarkReporter {
    private readonly resultsDir: string;

    /**
     * Creates a new benchmark reporter.
     * @param resultsDir Directory containing benchmark result files
     */
    constructor(resultsDir: string = 'test-results') {
        this.resultsDir = resultsDir;
    }

    /**
     * Loads all benchmark result files from the results directory.
     * @returns Map of benchmark name to results
     */
    loadAllResults(): Map<string, any> {
        const results = new Map<string, any>();

        if (!fs.existsSync(this.resultsDir)) {
            return results;
        }

        const files = fs.readdirSync(this.resultsDir)
            .filter(file => file.startsWith('benchmark-') && file.endsWith('.json'))
            .filter(file => !file.includes('comparison') && !file.includes('consolidated'));

        for (const file of files) {
            try {
                const filepath = path.join(this.resultsDir, file);
                const content = fs.readFileSync(filepath, 'utf-8');
                const data = JSON.parse(content);
                
                if (data.benchmark) {
                    results.set(data.benchmark, data);
                }
            } catch (error) {
                console.warn(`Failed to load benchmark file ${file}:`, error);
            }
        }

        return results;
    }

    /**
     * Generates a consolidated report from all available benchmark results.
     * @param version Optional version string to include in the report
     * @returns Consolidated benchmark report
     */
    generateConsolidatedReport(version: string = 'unknown'): ConsolidatedReport {
        const allResults = this.loadAllResults();
        const benchmarks: { [key: string]: any } = {};
        
        let totalTests = 0;
        let totalMessages = 0;
        const throughputs: number[] = [];
        const latencies: number[] = [];

        // Aggregate all benchmark results
        for (const [name, data] of allResults.entries()) {
            benchmarks[name] = data;

            // Count tests
            if (data.configuration) {
                if (data.configuration.iterations) {
                    totalTests += data.configuration.iterations;
                }
                if (data.configuration.totalMessages) {
                    totalMessages += data.configuration.totalMessages;
                }
            }

            // Collect throughput metrics
            if (data.summary?.throughput?.average) {
                throughputs.push(data.summary.throughput.average);
            }

            // Collect latency metrics
            if (data.summary?.latency?.average) {
                latencies.push(data.summary.latency.average);
            }
        }

        // Calculate averages
        const averageThroughput = throughputs.length > 0
            ? throughputs.reduce((sum, t) => sum + t, 0) / throughputs.length
            : undefined;

        const averageLatency = latencies.length > 0
            ? latencies.reduce((sum, l) => sum + l, 0) / latencies.length
            : undefined;

        const report: ConsolidatedReport = {
            timestamp: new Date().toISOString(),
            version,
            benchmarks,
            summary: {
                totalBenchmarks: allResults.size,
                totalTests,
                totalMessages,
                averageThroughput,
                averageLatency
            }
        };

        return report;
    }

    /**
     * Generates a formatted text summary of the consolidated report.
     * @param report Consolidated report
     * @returns Formatted text summary
     */
    generateTextSummary(report: ConsolidatedReport): string {
        const lines: string[] = [];

        lines.push('='.repeat(70));
        lines.push('CONSOLIDATED BENCHMARK REPORT');
        lines.push('='.repeat(70));
        lines.push(`Timestamp: ${report.timestamp}`);
        lines.push(`Version: ${report.version}`);
        lines.push('-'.repeat(70));
        lines.push('SUMMARY:');
        lines.push(`  Total benchmarks: ${report.summary.totalBenchmarks}`);
        lines.push(`  Total tests: ${report.summary.totalTests}`);
        lines.push(`  Total messages processed: ${report.summary.totalMessages.toLocaleString()}`);
        
        if (report.summary.averageThroughput) {
            lines.push(`  Average throughput: ${report.summary.averageThroughput.toFixed(2)} msg/s`);
        }
        
        if (report.summary.averageLatency) {
            lines.push(`  Average latency: ${report.summary.averageLatency.toFixed(2)} ms`);
        }
        
        lines.push('-'.repeat(70));
        lines.push('BENCHMARK DETAILS:');

        for (const [name, data] of Object.entries(report.benchmarks)) {
            lines.push(`\n${name.toUpperCase()}:`);
            
            if (data.summary?.throughput) {
                lines.push(`  Throughput: ${data.summary.throughput.average.toFixed(2)} msg/s`);
                lines.push(`    Min: ${data.summary.throughput.min.toFixed(2)} msg/s`);
                lines.push(`    Max: ${data.summary.throughput.max.toFixed(2)} msg/s`);
                if (data.summary.throughput.stdDev) {
                    lines.push(`    StdDev: ${data.summary.throughput.stdDev.toFixed(2)} msg/s`);
                }
            }
            
            if (data.summary?.latency) {
                lines.push(`  Latency:`);
                lines.push(`    Average: ${data.summary.latency.average.toFixed(2)} ms`);
                lines.push(`    P95: ${data.summary.latency.p95.toFixed(2)} ms`);
                lines.push(`    P99: ${data.summary.latency.p99.toFixed(2)} ms`);
            }
            
            if (data.summary?.overhead) {
                lines.push(`  Overhead: ${data.summary.overhead.percentage.toFixed(2)}%`);
            }
        }

        lines.push('\n' + '='.repeat(70));

        return lines.join('\n');
    }

    /**
     * Exports the consolidated report to a JSON file.
     * @param report Consolidated report
     * @param filename Output filename
     */
    exportConsolidatedReport(report: ConsolidatedReport, filename: string = 'benchmark-consolidated.json'): void {
        const filepath = path.join(this.resultsDir, filename);
        
        // Ensure directory exists
        if (!fs.existsSync(this.resultsDir)) {
            fs.mkdirSync(this.resultsDir, { recursive: true });
        }
        
        fs.writeFileSync(filepath, JSON.stringify(report, null, 2), 'utf-8');
    }

    /**
     * Generates a markdown report with benchmark results.
     * Useful for documentation or CI/CD integration.
     * @param report Consolidated report
     * @returns Markdown formatted report
     */
    generateMarkdownReport(report: ConsolidatedReport): string {
        const lines: string[] = [];

        lines.push('# Benchmark Results');
        lines.push('');
        lines.push(`**Timestamp:** ${report.timestamp}`);
        lines.push(`**Version:** ${report.version}`);
        lines.push('');
        lines.push('## Summary');
        lines.push('');
        lines.push(`- **Total Benchmarks:** ${report.summary.totalBenchmarks}`);
        lines.push(`- **Total Tests:** ${report.summary.totalTests}`);
        lines.push(`- **Total Messages:** ${report.summary.totalMessages.toLocaleString()}`);
        
        if (report.summary.averageThroughput) {
            lines.push(`- **Average Throughput:** ${report.summary.averageThroughput.toFixed(2)} msg/s`);
        }
        
        if (report.summary.averageLatency) {
            lines.push(`- **Average Latency:** ${report.summary.averageLatency.toFixed(2)} ms`);
        }
        
        lines.push('');
        lines.push('## Benchmark Details');
        lines.push('');

        for (const [name, data] of Object.entries(report.benchmarks)) {
            lines.push(`### ${name}`);
            lines.push('');
            
            if (data.summary?.throughput) {
                lines.push('**Throughput:**');
                lines.push('');
                lines.push('| Metric | Value |');
                lines.push('|--------|-------|');
                lines.push(`| Average | ${data.summary.throughput.average.toFixed(2)} msg/s |`);
                lines.push(`| Min | ${data.summary.throughput.min.toFixed(2)} msg/s |`);
                lines.push(`| Max | ${data.summary.throughput.max.toFixed(2)} msg/s |`);
                if (data.summary.throughput.stdDev) {
                    lines.push(`| StdDev | ${data.summary.throughput.stdDev.toFixed(2)} msg/s |`);
                }
                lines.push('');
            }
            
            if (data.summary?.latency) {
                lines.push('**Latency:**');
                lines.push('');
                lines.push('| Metric | Value |');
                lines.push('|--------|-------|');
                lines.push(`| Average | ${data.summary.latency.average.toFixed(2)} ms |`);
                lines.push(`| P50 | ${data.summary.latency.p50?.toFixed(2) || 'N/A'} ms |`);
                lines.push(`| P95 | ${data.summary.latency.p95.toFixed(2)} ms |`);
                lines.push(`| P99 | ${data.summary.latency.p99.toFixed(2)} ms |`);
                lines.push('');
            }
            
            if (data.summary?.overhead) {
                lines.push('**Overhead:**');
                lines.push('');
                lines.push(`- Percentage: ${data.summary.overhead.percentage.toFixed(2)}%`);
                lines.push(`- Absolute: ${data.summary.overhead.absolute.toFixed(2)} ms`);
                lines.push('');
            }
        }

        lines.push('---');
        lines.push('');
        lines.push('## How to Interpret Results');
        lines.push('');
        lines.push('### Throughput');
        lines.push('- Measures messages processed per second');
        lines.push('- Higher is better');
        lines.push('- StdDev indicates consistency (lower is more consistent)');
        lines.push('');
        lines.push('### Latency');
        lines.push('- Measures time from publish to handler completion');
        lines.push('- Lower is better');
        lines.push('- P95/P99 show worst-case performance for 95%/99% of messages');
        lines.push('');
        lines.push('### Overhead');
        lines.push('- Measures performance cost of features (e.g., EventStore, middleware)');
        lines.push('- Lower is better');
        lines.push('- Percentage shows relative impact on performance');

        return lines.join('\n');
    }

    /**
     * Exports a markdown report to a file.
     * @param report Consolidated report
     * @param filename Output filename
     */
    exportMarkdownReport(report: ConsolidatedReport, filename: string = 'BENCHMARK_RESULTS.md'): void {
        const filepath = path.join(this.resultsDir, filename);
        const markdown = this.generateMarkdownReport(report);
        
        // Ensure directory exists
        if (!fs.existsSync(this.resultsDir)) {
            fs.mkdirSync(this.resultsDir, { recursive: true });
        }
        
        fs.writeFileSync(filepath, markdown, 'utf-8');
    }
}
