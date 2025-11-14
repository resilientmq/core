# GitHub Actions Workflows

This directory contains the CI/CD workflows for @resilientmq/core.

## Workflows

### test.yml - Automated Testing Pipeline

Comprehensive test suite that runs on every push and pull request.

**Jobs:**

1. **Unit Tests** (Matrix: Node 18, 20, 22)
   - Runs unit tests with coverage
   - Enforces 70% minimum coverage threshold
   - Uploads coverage reports and test results
   - Timeout: 10 minutes

2. **Integration Tests** (Matrix: Node 18, 20, 22)
   - Tests with real RabbitMQ instance
   - Uses GitHub Actions services for RabbitMQ
   - Validates end-to-end functionality
   - Timeout: 15 minutes

3. **Stress Tests** (Conditional: PRs only)
   - High-volume and high-speed testing
   - Validates system under load
   - Checks error rate < 1%
   - Timeout: 20 minutes

4. **Benchmarks** (Conditional: main/master branch only)
   - Performance benchmarking
   - Regression detection (> 10% threshold)
   - Results stored for 90 days
   - Timeout: 25 minutes

5. **Test Summary**
   - Aggregates results from all jobs
   - Provides quick overview in GitHub UI
   - Fails if any required test fails

**Triggers:**
- Push to main, master, or develop branches
- Pull requests to main, master, or develop branches

**Optimizations:**
- npm dependency caching
- Jest cache for faster test execution
- Parallel execution across Node versions
- Conditional job execution

### publish.yml - NPM Publishing

Automatically publishes to NPM when version changes on master branch.

**Features:**
- Version change detection
- Duplicate publish prevention
- Automatic git tagging
- Build artifact preparation

## Quality Gates

### Coverage Requirements
- Lines: ≥ 70%
- Branches: ≥ 70%
- Functions: ≥ 75%
- Statements: ≥ 75%

### Performance Requirements
- Error rate in stress tests: < 1%
- Benchmark regression: < 10%
- No memory leaks detected

### Test Requirements
- All unit tests must pass
- All integration tests must pass
- Tests must complete within timeout limits

## Scripts

### check-coverage.js
Validates code coverage against minimum thresholds.

```bash
npm run coverage:check
```

### compare-benchmarks.js
Compares current benchmarks against baseline to detect regressions.

```bash
npm run benchmark:compare
```

## Artifacts

### Coverage Reports
- Format: HTML, LCOV, JSON
- Location: `coverage/` directory
- Retention: 30 days
- Uploaded from: Node 20 only

### Test Results
- Format: JUnit XML
- Location: `test-results/` directory
- Retention: 30 days
- Uploaded from: All Node versions

### Benchmark Results
- Format: JSON
- Location: `test-results/benchmark-*.json`
- Retention: 90 days
- Uploaded from: main/master branch only

## Local Development

Run the same checks locally before pushing:

```bash
# Unit tests with coverage
npm run test:coverage
npm run coverage:check

# Integration tests (requires Docker)
npm run test:integration

# Stress tests (requires Docker)
npm run test:stress

# Benchmarks (requires Docker)
npm run test:benchmark
npm run benchmark:compare

# All tests
npm run test:all
```

## Troubleshooting

### Tests Failing in CI but Passing Locally

1. Check Node version compatibility
2. Verify Docker/RabbitMQ availability
3. Check for timing-dependent tests
4. Review CI logs for environment differences

### Coverage Below Threshold

1. Run `npm run test:coverage` locally
2. Check coverage report in `coverage/unit/index.html`
3. Add tests for uncovered code
4. Verify coverage configuration in `jest.config.unit.js`

### Benchmark Regressions

1. Run `npm run test:benchmark` locally
2. Compare with baseline in `test-results/benchmark-baseline.json`
3. Investigate performance changes
4. Update baseline if regression is intentional

### Timeout Issues

1. Check for hanging processes
2. Review test logs for slow operations
3. Consider increasing timeout in workflow
4. Optimize slow tests

## Maintenance

### Updating Node Versions

Edit the matrix in `.github/workflows/test.yml`:

```yaml
strategy:
  matrix:
    node-version: [18, 20, 22]  # Update versions here
```

### Adjusting Timeouts

Edit timeout values in workflow jobs:

```yaml
timeout-minutes: 10  # Adjust as needed
```

### Updating Coverage Thresholds

Edit `test/jest.config.unit.js`:

```javascript
coverageThreshold: {
  global: {
    branches: 70,
    functions: 75,
    lines: 75,
    statements: 75
  }
}
```

## References

- [CI Optimization Guide](./CI-OPTIMIZATION.md)
- [Test Documentation](../test/README.md)
- [GitHub Actions Documentation](https://docs.github.com/en/actions)
