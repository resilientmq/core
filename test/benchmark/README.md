# Benchmark Tests

This directory contains performance benchmark tests for the ResilientMQ core library.

## Available Benchmarks

### 1. Publish Throughput (`publish-throughput.bench.ts`)
Measures the throughput of publishing messages to RabbitMQ.

- **Iterations:** 5
- **Messages per iteration:** 1000
- **Metrics:** Throughput (msg/s), latency (avg, P95, P99)
- **Output:** `test-results/benchmark-publish-throughput.json`

### 2. Consume Throughput (`consume-throughput.bench.ts`)
Measures the throughput of consuming messages from RabbitMQ.

- **Iterations:** 5
- **Messages per iteration:** 1000
- **Metrics:** Throughput (msg/s), latency (avg, P95, P99)
- **Output:** `test-results/benchmark-consume-throughput.json`

### 3. End-to-End Latency (`end-to-end-latency.bench.ts`)
Measures latency from publish to handler completion with different payload sizes.

- **Payload sizes:** Small (~100 bytes), Medium (~1KB), Large (~10KB)
- **Tests:** With and without persistence
- **Metrics:** P50, P95, P99 latencies
- **Output:** `test-results/benchmark-end-to-end-latency.json`

### 4. EventStore Overhead (`eventstore-overhead.bench.ts`)
Measures the performance overhead of using EventStore.

- **Iterations:** 3
- **Messages per test:** 1000
- **Metrics:** Time with/without store, percentage overhead
- **Output:** `test-results/benchmark-eventstore-overhead.json`

### 5. Middleware Impact (`middleware-impact.bench.ts`)
Measures the performance impact of middleware on message processing.

- **Middleware counts:** 0, 1, 3, 5
- **Messages per test:** 500
- **Metrics:** Throughput degradation per middleware
- **Output:** `test-results/benchmark-middleware-impact.json`

## Running Benchmarks

### Run All Benchmarks
```bash
npm run test:benchmark
```

### Run Specific Benchmark
```bash
npm run test:benchmark -- publish-throughput.bench.ts
npm run test:benchmark -- consume-throughput.bench.ts
npm run test:benchmark -- end-to-end-latency.bench.ts
npm run test:benchmark -- eventstore-overhead.bench.ts
npm run test:benchmark -- middleware-impact.bench.ts
```

### Run with Pattern Matching
```bash
npm run test:benchmark -- --testNamePattern="Publish Throughput"
```

## Generating Reports

### Generate Consolidated Report
After running benchmarks, generate a consolidated report:

```bash
npm run benchmark:report
```

This will create:
- `test-results/benchmark-consolidated.json` - JSON report with all benchmark results
- `test-results/BENCHMARK_RESULTS.md` - Markdown report for documentation

### Generate Report with Version
```bash
npm run benchmark:report -- --version 1.2.0
```

### Compare Benchmark Results
Compare two benchmark result files to detect regressions:

```bash
npm run benchmark:report -- --compare benchmark-publish-throughput.json benchmark-publish-throughput-new.json
```

This will:
- Generate a comparison report at `test-results/benchmark-comparison.json`
- Print a detailed comparison to console
- Exit with error code 1 if regressions > 10% are detected

## Understanding Results

### Throughput
- **Unit:** messages/second (msg/s)
- **Higher is better**
- **StdDev:** Lower standard deviation indicates more consistent performance

### Latency
- **Unit:** milliseconds (ms)
- **Lower is better**
- **P50:** Median latency (50% of messages)
- **P95:** 95th percentile (95% of messages are faster)
- **P99:** 99th percentile (99% of messages are faster)

### Overhead
- **Unit:** percentage (%)
- **Lower is better**
- Shows the performance cost of features like EventStore or middleware

### Regression Detection
- **Threshold:** 10% by default
- **Throughput:** Decrease > 10% is a regression
- **Latency:** Increase > 10% is a regression
- **Overhead:** Increase > 10% is a regression

## Requirements

- **Docker:** Required for RabbitMQ containers (via Testcontainers)
- **Memory:** At least 4GB available
- **Time:** Full benchmark suite takes ~10-15 minutes

## Configuration

Benchmark configuration can be modified in each test file:

```typescript
const ITERATIONS = 5;              // Number of iterations
const MESSAGES_PER_ITERATION = 1000; // Messages per iteration
const PAYLOAD_SIZES = [...];       // Payload size configurations
```

## CI/CD Integration

Benchmarks can be integrated into CI/CD pipelines:

```yaml
# Example GitHub Actions workflow
- name: Run Benchmarks
  run: npm run test:benchmark

- name: Generate Report
  run: npm run benchmark:report -- --version ${{ github.sha }}

- name: Compare with Baseline
  run: npm run benchmark:report -- --compare baseline.json current.json
```

## Troubleshooting

### Benchmarks Timeout
- Increase timeout in test file: `it('test', async () => {...}, 300000);`
- Check Docker resources (CPU, memory)

### Inconsistent Results
- Close other applications to reduce system load
- Run benchmarks multiple times and average results
- Check for background processes consuming resources

### Container Startup Failures
- Ensure Docker is running
- Check Docker logs: `docker logs <container-id>`
- Verify port availability (5672, 15672)

## Best Practices

1. **Run on dedicated hardware** for consistent results
2. **Close unnecessary applications** before running benchmarks
3. **Run multiple times** to account for variance
4. **Compare against baseline** to detect regressions
5. **Document system specs** when sharing results
6. **Use version tags** when generating reports

## Output Files

All benchmark results are saved to `test-results/`:

```
test-results/
├── benchmark-publish-throughput.json
├── benchmark-consume-throughput.json
├── benchmark-end-to-end-latency.json
├── benchmark-eventstore-overhead.json
├── benchmark-middleware-impact.json
├── benchmark-consolidated.json
├── benchmark-comparison.json
└── BENCHMARK_RESULTS.md
```

## Contributing

When adding new benchmarks:

1. Follow the naming convention: `<name>.bench.ts`
2. Use `MetricsCollector` for consistent metrics
3. Export results to JSON in `test-results/`
4. Document the benchmark in this README
5. Add appropriate timeouts for long-running tests
6. Include console output for real-time feedback
