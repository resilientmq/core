#!/usr/bin/env node

/**
 * Coverage Threshold Checker
 * 
 * Validates that code coverage meets minimum thresholds.
 * Used in CI/CD to enforce quality gates.
 */

const fs = require('fs');
const path = require('path');

const COVERAGE_FILE = path.join(__dirname, '../../coverage/unit/coverage-summary.json');
const MIN_COVERAGE = {
  lines: 70,
  branches: 70,
  functions: 75,
  statements: 75
};

/**
 * Check coverage thresholds
 */
function checkCoverage() {
  console.log('🔍 Checking coverage thresholds...\n');
  
  if (!fs.existsSync(COVERAGE_FILE)) {
    console.error('❌ Coverage file not found:', COVERAGE_FILE);
    console.error('   Run tests with coverage first: npm run test:coverage');
    return false;
  }
  
  const coverage = JSON.parse(fs.readFileSync(COVERAGE_FILE, 'utf8'));
  const total = coverage.total;
  
  console.log('📊 Coverage Results:');
  console.log('─'.repeat(50));
  console.log(`  Lines:      ${total.lines.pct.toFixed(2)}% (min: ${MIN_COVERAGE.lines}%)`);
  console.log(`  Branches:   ${total.branches.pct.toFixed(2)}% (min: ${MIN_COVERAGE.branches}%)`);
  console.log(`  Functions:  ${total.functions.pct.toFixed(2)}% (min: ${MIN_COVERAGE.functions}%)`);
  console.log(`  Statements: ${total.statements.pct.toFixed(2)}% (min: ${MIN_COVERAGE.statements}%)`);
  console.log('─'.repeat(50));
  
  const failures = [];
  
  if (total.lines.pct < MIN_COVERAGE.lines) {
    failures.push(`Lines: ${total.lines.pct.toFixed(2)}% < ${MIN_COVERAGE.lines}%`);
  }
  if (total.branches.pct < MIN_COVERAGE.branches) {
    failures.push(`Branches: ${total.branches.pct.toFixed(2)}% < ${MIN_COVERAGE.branches}%`);
  }
  if (total.functions.pct < MIN_COVERAGE.functions) {
    failures.push(`Functions: ${total.functions.pct.toFixed(2)}% < ${MIN_COVERAGE.functions}%`);
  }
  if (total.statements.pct < MIN_COVERAGE.statements) {
    failures.push(`Statements: ${total.statements.pct.toFixed(2)}% < ${MIN_COVERAGE.statements}%`);
  }
  
  if (failures.length > 0) {
    console.log('\n❌ Coverage below minimum thresholds:\n');
    failures.forEach(failure => console.log(`  • ${failure}`));
    console.log('\n💡 Tip: Add more tests to increase coverage');
    return false;
  }
  
  console.log('\n✅ All coverage thresholds met!');
  return true;
}

// Main execution
if (require.main === module) {
  const passed = checkCoverage();
  process.exit(passed ? 0 : 1);
}

module.exports = { checkCoverage };
