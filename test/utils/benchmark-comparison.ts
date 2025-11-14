import * as fs from 'fs';
import * as path from 'path';

/**
 * Benchmark comparison result for a single metric
 */
export interface MetricComparison {
    metric: string;
    baseline: number;
    current: number;
    difference: number;
    percentageChange: number;
    isRegression: boolean;
    unit: string;
}

/**
 * Benchmark comparison report
 */
export interface ComparisonReport {
    timestamp: string;
    baselineFile: string;
    currentFile: string;
    regressionThreshold: number;
    hasRegressions: boolean;
    comparisons: MetricComparison[];
    summary: {
        totalMetrics: number;
        regressions: number;
        improvements: number;
        unchanged: number;
    };
}

/**
 * Utility for comparing benchmark results between versions.
 * Loads historical results and detects performance regressions.
 */
export class BenchmarkComparison {
    private readonly resultsDir: string;
    private readonly regressionThreshold: number;

    /**
     * Creates a new benchmark comparison utility.
     * @param resultsDir Directory containing benchmark result files
     * @param regressionThreshold Percentage threshold for detecting regressions (default: 10%)
     */
    constructor(resultsDir: string = 'test-results', regressionThreshold: number = 10) {
        this.resultsDir = resultsDir;
        this.regressionThreshold = regressionThreshold;
    }

    /**
     * Loads benchmark results from a JSON file.
     * @param filename Name of the benchmark result file
     * @returns Parsed benchmark results
     */
    loadResults(filename: string): any {
        const filepath = path.join(this.resultsDir, filename);
        
        if (!fs.existsSync(filepath)) {
            throw new Error(`Benchmark results file not found: ${filepath}`);
        }

        const content = fs.readFileSync(filepath, 'utf-8');
        return JSON.parse(content);
    }

    /**
     * Compares two benchmark result files and generates a comparison report.
     * @param baselineFile Baseline benchmark results file
     * @param currentFile Current benchmark results file
     * @returns Comparison report with detected regressions
     */
    compare(baselineFile: string, currentFile: string): ComparisonReport {
        const baseline = this.loadResults(baselineFile);
        const current = this.loadResults(currentFile);

        if (baseline.benchmark !== current.benchmark) {
            throw new Error(`Benchmark type mismatch: ${baseline.benchmark} vs ${current.benchmark}`);
        }

        const comparisons: MetricComparison[] = [];

        // Compare summary metrics
        if (baseline.summary && current.summary) {
            comparisons.push(...this.compareSummary(baseline.summary, current.summary));
        }

        // Count regressions and improvements
        const regressions = comparisons.filter(c => c.isRegression).length;
        const improvements = comparisons.filter(c => c.percentageChange < -this.regressionThreshold).length;
        const unchanged = comparisons.length - regressions - improvements;

        const report: ComparisonReport = {
            timestamp: new Date().toISOString(),
            baselineFile,
            currentFile,
            regressionThreshold: this.regressionThreshold,
            hasRegressions: regressions > 0,
            comparisons,
            summary: {
                totalMetrics: comparisons.length,
                regressions,
                improvements,
                unchanged
            }
        };

        return report;
    }

    /**
     * Compares summary metrics between baseline and current results.
     * @param baselineSummary Baseline summary metrics
     * @param currentSummary Current summary metrics
     * @returns Array of metric comparisons
     */
    private compareSummary(baselineSummary: any, currentSummary: any): MetricComparison[] {
        const comparisons: MetricComparison[] = [];

        // Compare throughput metrics
        if (baselineSummary.throughput && currentSummary.throughput) {
            const baselineValue = baselineSummary.throughput.average;
            const currentValue = currentSummary.throughput.average;
            const difference = currentValue - baselineValue;
            const percentageChange = (difference / baselineValue) * 100;
            
            // For throughput, negative change is a regression (lower is worse)
            const isRegression = percentageChange < -this.regressionThreshold;

            comparisons.push({
                metric: 'throughput.average',
                baseline: baselineValue,
                current: currentValue,
                difference,
                percentageChange,
                isRegression,
                unit: baselineSummary.throughput.unit || 'messages/second'
            });
        }

        // Compare latency metrics
        if (baselineSummary.latency && currentSummary.latency) {
            const latencyMetrics = ['average', 'p95', 'p99'];
            
            for (const metric of latencyMetrics) {
                if (baselineSummary.latency[metric] !== undefined && currentSummary.latency[metric] !== undefined) {
                    const baselineValue = baselineSummary.latency[metric];
                    const currentValue = currentSummary.latency[metric];
                    const difference = currentValue - baselineValue;
                    const percentageChange = baselineValue > 0 ? (difference / baselineValue) * 100 : 0;
                    
                    // For latency, positive change is a regression (higher is worse)
                    const isRegression = percentageChange > this.regressionThreshold;

                    comparisons.push({
                        metric: `latency.${metric}`,
                        baseline: baselineValue,
                        current: currentValue,
                        difference,
                        percentageChange,
                        isRegression,
                        unit: baselineSummary.latency.unit || 'milliseconds'
                    });
                }
            }
        }

        // Compare overhead metrics
        if (baselineSummary.overhead && currentSummary.overhead) {
            const baselineValue = baselineSummary.overhead.percentage;
            const currentValue = currentSummary.overhead.percentage;
            const difference = currentValue - baselineValue;
            const percentageChange = baselineValue > 0 ? (difference / baselineValue) * 100 : 0;
            
            // For overhead, positive change is a regression (higher is worse)
            const isRegression = percentageChange > this.regressionThreshold;

            comparisons.push({
                metric: 'overhead.percentage',
                baseline: baselineValue,
                current: currentValue,
                difference,
                percentageChange,
                isRegression,
                unit: 'percentage'
            });
        }

        return comparisons;
    }

    /**
     * Generates a formatted text report from a comparison.
     * @param report Comparison report
     * @returns Formatted text report
     */
    generateTextReport(report: ComparisonReport): string {
        const lines: string[] = [];

        lines.push('='.repeat(70));
        lines.push('BENCHMARK COMPARISON REPORT');
        lines.push('='.repeat(70));
        lines.push(`Timestamp: ${report.timestamp}`);
        lines.push(`Baseline: ${report.baselineFile}`);
        lines.push(`Current: ${report.currentFile}`);
        lines.push(`Regression threshold: ${report.regressionThreshold}%`);
        lines.push('-'.repeat(70));
        lines.push('SUMMARY:');
        lines.push(`  Total metrics: ${report.summary.totalMetrics}`);
        lines.push(`  Regressions: ${report.summary.regressions}`);
        lines.push(`  Improvements: ${report.summary.improvements}`);
        lines.push(`  Unchanged: ${report.summary.unchanged}`);
        lines.push('-'.repeat(70));

        if (report.hasRegressions) {
            lines.push('⚠️  REGRESSIONS DETECTED:');
            for (const comparison of report.comparisons.filter(c => c.isRegression)) {
                lines.push(`  ${comparison.metric}:`);
                lines.push(`    Baseline: ${comparison.baseline.toFixed(2)} ${comparison.unit}`);
                lines.push(`    Current: ${comparison.current.toFixed(2)} ${comparison.unit}`);
                lines.push(`    Change: ${comparison.percentageChange > 0 ? '+' : ''}${comparison.percentageChange.toFixed(2)}%`);
            }
            lines.push('-'.repeat(70));
        }

        const improvements = report.comparisons.filter(c => c.percentageChange < -report.regressionThreshold);
        if (improvements.length > 0) {
            lines.push('✅ IMPROVEMENTS:');
            for (const comparison of improvements) {
                lines.push(`  ${comparison.metric}:`);
                lines.push(`    Baseline: ${comparison.baseline.toFixed(2)} ${comparison.unit}`);
                lines.push(`    Current: ${comparison.current.toFixed(2)} ${comparison.unit}`);
                lines.push(`    Change: ${comparison.percentageChange.toFixed(2)}%`);
            }
            lines.push('-'.repeat(70));
        }

        lines.push('ALL METRICS:');
        for (const comparison of report.comparisons) {
            const status = comparison.isRegression ? '⚠️' : 
                          comparison.percentageChange < -report.regressionThreshold ? '✅' : '➖';
            lines.push(`  ${status} ${comparison.metric}:`);
            lines.push(`    ${comparison.baseline.toFixed(2)} → ${comparison.current.toFixed(2)} ${comparison.unit} (${comparison.percentageChange > 0 ? '+' : ''}${comparison.percentageChange.toFixed(2)}%)`);
        }

        lines.push('='.repeat(70));

        return lines.join('\n');
    }

    /**
     * Exports a comparison report to a JSON file.
     * @param report Comparison report
     * @param filename Output filename
     */
    exportReport(report: ComparisonReport, filename: string = 'benchmark-comparison.json'): void {
        const filepath = path.join(this.resultsDir, filename);
        fs.writeFileSync(filepath, JSON.stringify(report, null, 2), 'utf-8');
    }

    /**
     * Lists all available benchmark result files in the results directory.
     * @returns Array of benchmark result filenames
     */
    listAvailableResults(): string[] {
        if (!fs.existsSync(this.resultsDir)) {
            return [];
        }

        return fs.readdirSync(this.resultsDir)
            .filter(file => file.startsWith('benchmark-') && file.endsWith('.json'))
            .filter(file => file !== 'benchmark-comparison.json');
    }
}
