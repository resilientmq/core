#!/usr/bin/env node

/**
 * Script to generate consolidated benchmark reports.
 * 
 * Usage:
 *   npm run benchmark:report
 *   npm run benchmark:report -- --version 1.2.0
 *   npm run benchmark:report -- --compare baseline.json current.json
 */

import { BenchmarkReporter } from '../utils/benchmark-reporter';
import { BenchmarkComparison } from '../utils/benchmark-comparison';
import * as path from 'path';

// Parse command line arguments
const args = process.argv.slice(2);
const versionIndex = args.indexOf('--version');
const compareIndex = args.indexOf('--compare');

const version = versionIndex >= 0 && args[versionIndex + 1] 
    ? args[versionIndex + 1] 
    : process.env.npm_package_version || 'unknown';

const resultsDir = path.join(__dirname, '../../test-results');

// Generate consolidated report
console.log('Generating consolidated benchmark report...\n');

const reporter = new BenchmarkReporter(resultsDir);
const report = reporter.generateConsolidatedReport(version);

// Export reports
reporter.exportConsolidatedReport(report);
console.log(`✅ Consolidated JSON report exported to: ${resultsDir}/benchmark-consolidated.json`);

reporter.exportMarkdownReport(report);
console.log(`✅ Markdown report exported to: ${resultsDir}/BENCHMARK_RESULTS.md`);

// Print text summary
console.log('\n' + reporter.generateTextSummary(report));

// If comparison requested, generate comparison report
if (compareIndex >= 0) {
    const baselineFile = args[compareIndex + 1];
    const currentFile = args[compareIndex + 2];

    if (!baselineFile || !currentFile) {
        console.error('\n❌ Error: --compare requires two filenames (baseline and current)');
        console.error('Usage: npm run benchmark:report -- --compare baseline.json current.json');
        process.exit(1);
    }

    try {
        console.log(`\nComparing benchmarks: ${baselineFile} vs ${currentFile}...\n`);
        
        const comparison = new BenchmarkComparison(resultsDir);
        const comparisonReport = comparison.compare(baselineFile, currentFile);
        
        comparison.exportReport(comparisonReport);
        console.log(`✅ Comparison report exported to: ${resultsDir}/benchmark-comparison.json`);
        
        console.log('\n' + comparison.generateTextReport(comparisonReport));
        
        // Exit with error code if regressions detected
        if (comparisonReport.hasRegressions) {
            console.error('\n❌ Performance regressions detected!');
            process.exit(1);
        } else {
            console.log('\n✅ No performance regressions detected.');
        }
    } catch (error) {
        console.error('\n❌ Error during comparison:', error instanceof Error ? error.message : String(error));
        process.exit(1);
    }
}

console.log('\n✅ Benchmark report generation complete!\n');
