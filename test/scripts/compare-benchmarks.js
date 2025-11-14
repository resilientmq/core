#!/usr/bin/env node

/**
 * Benchmark Comparison Script
 * 
 * Compares current benchmark results against baseline to detect performance regressions.
 * Fails if any metric shows regression > 10%.
 */

const fs = require('fs');
const path = require('path');

const REGRESSION_THRESHOLD = 10; // 10% regression threshold
const RESULTS_DIR = path.join(__dirname, '../../test-results');
const BASELINE_FILE = path.join(RESULTS_DIR, 'benchmark-baseline.json');

/**
 * Load benchmark results from file
 */
function loadBenchmarkResults(filename) {
  const filepath = path.join(RESULTS_DIR, filename);
  if (!fs.existsSync(filepath)) {
    return null;
  }
  
  try {
    const content = fs.readFileSync(filepath, 'utf8');
    return JSON.parse(content);
  } catch (error) {
    console.error(`Error loading ${filename}:`, error.message);
    return null;
  }
}

/**
 * Calculate percentage change
 */
function calculateChange(baseline, current) {
  if (!baseline || baseline === 0) return 0;
  return ((current - baseline) / baseline) * 100;
}

/**
 * Check if metric shows regression
 * For throughput: lower is worse (negative change is regression)
 * For latency: higher is worse (positive change is regression)
 */
function isRegression(metricName, change) {
  const throughputMetrics = ['throughput', 'msgPerSecond'];
  const latencyMetrics = ['latency', 'duration'];
  
  const isThroughput = throughputMetrics.some(m => metricName.toLowerCase().includes(m));
  const isLatency = latencyMetrics.some(m => metricName.toLowerCase().includes(m));
  
  if (isThroughput) {
    // For throughput, negative change > threshold is regression
    return change < -REGRESSION_THRESHOLD;
  } else if (isLatency) {
    // For latency, positive change > threshold is regression
    return change > REGRESSION_THRESHOLD;
  }
  
  return false;
}

/**
 * Compare benchmark results
 */
function compareBenchmarks() {
  console.log('🔍 Checking for performance regressions...\n');
  
  // Load baseline
  if (!fs.existsSync(BASELINE_FILE)) {
    console.log('⚠️  No baseline found. Current results will be saved as baseline.');
    saveCurrentAsBaseline();
    return { hasRegression: false, message: 'Baseline created' };
  }
  
  const baseline = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8'));
  
  // Load current results
  const benchmarkFiles = [
    'benchmark-publish-throughput.json',
    'benchmark-consume-throughput.json',
    'benchmark-end-to-end-latency.json',
    'benchmark-store-overhead.json',
    'benchmark-middleware-impact.json'
  ];
  
  let hasRegression = false;
  const regressions = [];
  const improvements = [];
  
  console.log('📊 Benchmark Comparison Results:\n');
  console.log('Baseline:', baseline.timestamp || 'Unknown');
  console.log('Current:', new Date().toISOString());
  console.log('Regression Threshold:', `${REGRESSION_THRESHOLD}%\n`);
  
  for (const filename of benchmarkFiles) {
    const current = loadBenchmarkResults(filename);
    if (!current) {
      console.log(`⚠️  ${filename}: Not found, skipping`);
      continue;
    }
    
    const benchmarkName = filename.replace('benchmark-', '').replace('.json', '');
    const baselineData = baseline[benchmarkName];
    
    if (!baselineData) {
      console.log(`⚠️  ${benchmarkName}: No baseline data, skipping`);
      continue;
    }
    
    console.log(`\n📈 ${benchmarkName}:`);
    console.log('─'.repeat(60));
    
    // Compare key metrics
    const metrics = extractMetrics(current);
    const baselineMetrics = extractMetrics(baselineData);
    
    for (const [metricName, currentValue] of Object.entries(metrics)) {
      const baselineValue = baselineMetrics[metricName];
      
      if (baselineValue === undefined) continue;
      
      const change = calculateChange(baselineValue, currentValue);
      const isReg = isRegression(metricName, change);
      
      const changeStr = change >= 0 ? `+${change.toFixed(2)}%` : `${change.toFixed(2)}%`;
      const icon = isReg ? '❌' : (Math.abs(change) > 5 ? '⚠️ ' : '✅');
      
      console.log(`  ${icon} ${metricName}:`);
      console.log(`     Baseline: ${formatValue(metricName, baselineValue)}`);
      console.log(`     Current:  ${formatValue(metricName, currentValue)}`);
      console.log(`     Change:   ${changeStr}`);
      
      if (isReg) {
        hasRegression = true;
        regressions.push({
          benchmark: benchmarkName,
          metric: metricName,
          baseline: baselineValue,
          current: currentValue,
          change: change
        });
      } else if (Math.abs(change) > 5) {
        improvements.push({
          benchmark: benchmarkName,
          metric: metricName,
          change: change
        });
      }
    }
  }
  
  // Print summary
  console.log('\n' + '='.repeat(60));
  console.log('📋 SUMMARY');
  console.log('='.repeat(60));
  
  if (hasRegression) {
    console.log('\n❌ PERFORMANCE REGRESSIONS DETECTED:\n');
    regressions.forEach(reg => {
      console.log(`  • ${reg.benchmark} - ${reg.metric}`);
      console.log(`    ${formatValue(reg.metric, reg.baseline)} → ${formatValue(reg.metric, reg.current)} (${reg.change.toFixed(2)}%)`);
    });
    console.log(`\n⚠️  ${regressions.length} regression(s) exceed ${REGRESSION_THRESHOLD}% threshold`);
  } else {
    console.log('\n✅ No performance regressions detected');
  }
  
  if (improvements.length > 0) {
    console.log('\n🎉 Performance Improvements:\n');
    improvements.forEach(imp => {
      console.log(`  • ${imp.benchmark} - ${imp.metric}: ${imp.change.toFixed(2)}%`);
    });
  }
  
  console.log('\n' + '='.repeat(60));
  
  return { hasRegression, regressions, improvements };
}

/**
 * Extract key metrics from benchmark result
 */
function extractMetrics(data) {
  const metrics = {};
  
  if (data.avgThroughput !== undefined) metrics.throughput = data.avgThroughput;
  if (data.throughput !== undefined) metrics.throughput = data.throughput;
  if (data.avgLatency !== undefined) metrics.avgLatency = data.avgLatency;
  if (data.latencyAvg !== undefined) metrics.avgLatency = data.latencyAvg;
  if (data.latencyP95 !== undefined) metrics.p95Latency = data.latencyP95;
  if (data.latencyP99 !== undefined) metrics.p99Latency = data.latencyP99;
  if (data.overhead !== undefined) metrics.overhead = data.overhead;
  if (data.overheadPercent !== undefined) metrics.overheadPercent = data.overheadPercent;
  
  return metrics;
}

/**
 * Format value based on metric type
 */
function formatValue(metricName, value) {
  if (metricName.toLowerCase().includes('throughput')) {
    return `${value.toFixed(2)} msg/s`;
  } else if (metricName.toLowerCase().includes('latency') || metricName.toLowerCase().includes('duration')) {
    return `${value.toFixed(2)} ms`;
  } else if (metricName.toLowerCase().includes('percent')) {
    return `${value.toFixed(2)}%`;
  }
  return value.toFixed(2);
}

/**
 * Save current results as baseline
 */
function saveCurrentAsBaseline() {
  const baseline = {
    timestamp: new Date().toISOString(),
    version: process.env.npm_package_version || 'unknown'
  };
  
  const benchmarkFiles = [
    'benchmark-publish-throughput.json',
    'benchmark-consume-throughput.json',
    'benchmark-end-to-end-latency.json',
    'benchmark-store-overhead.json',
    'benchmark-middleware-impact.json'
  ];
  
  for (const filename of benchmarkFiles) {
    const data = loadBenchmarkResults(filename);
    if (data) {
      const benchmarkName = filename.replace('benchmark-', '').replace('.json', '');
      baseline[benchmarkName] = data;
    }
  }
  
  fs.writeFileSync(BASELINE_FILE, JSON.stringify(baseline, null, 2));
  console.log(`✅ Baseline saved to ${BASELINE_FILE}`);
}

// Main execution
if (require.main === module) {
  try {
    const result = compareBenchmarks();
    
    // Exit with error code if regressions detected
    if (result.hasRegression) {
      console.error('\n❌ Build failed due to performance regressions');
      process.exit(1);
    }
    
    console.log('\n✅ Benchmark comparison completed successfully');
    process.exit(0);
  } catch (error) {
    console.error('Error during benchmark comparison:', error);
    process.exit(1);
  }
}

module.exports = { compareBenchmarks, calculateChange, isRegression };
