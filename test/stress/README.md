# Stress Tests

This directory contains stress tests for the @resilientmq/core library. These tests validate the system's behavior under extreme load conditions and help identify performance bottlenecks, memory leaks, and resilience issues.

## Test Files

### 1. High Volume Publishing (`high-volume-publish.stress.test.ts`)
Tests the system's ability to handle a large number of concurrent message publications.

**What it tests:**
- Publishing 10,000 messages concurrently using `Promise.all`
- Error rate validation (must be < 1%)
- Throughput measurement
- Latency metrics (avg, P50, P95, P99)

**Expected behavior:**
- All messages should be published successfully
- Error rate should remain below 1%
- System should maintain reasonable throughput

### 2. High Speed Consumption (`high-speed-consume.stress.test.ts`)
Tests the consumer's ability to process messages at high speed over an extended period.

**What it tests:**
- Continuous message consumption for 60 seconds
- High-speed message publishing (every 10ms)
- Processing throughput measurement
- Error-free processing validation

**Expected behavior:**
- No processing errors
- All published messages should be consumed
- System should maintain consistent throughput

### 3. Memory Leak Detection (`memory-leak.stress.test.ts`)
Tests for memory leaks during prolonged message processing.

**What it tests:**
- Processing 1000+ messages in a loop
- Memory usage tracking every 100 messages
- Garbage collection between measurements
- Memory growth analysis

**Expected behavior:**
- Memory increase should be less than 50MB
- Memory should stabilize (not grow continuously)
- No significant memory leaks

### 4. Concurrent Consumers (`concurrent-consumers.stress.test.ts`)
Tests load distribution across multiple consumers competing for messages.

**What it tests:**
- 5 concurrent consumers processing from the same queue
- 1000 messages distributed across consumers
- Message deduplication (no message processed twice)
- Load balance analysis

**Expected behavior:**
- All messages processed exactly once
- Each consumer should process at least some messages
- Load should be reasonably distributed (no consumer > 40%)

### 5. Recovery Under Load (`recovery-under-load.stress.test.ts`)
Tests the system's ability to recover from failures under high load.

**What it tests:**
- High volume message processing
- Random failures (20% of messages fail initially)
- Retry logic validation
- Recovery rate measurement

**Expected behavior:**
- At least 95% of messages eventually processed successfully
- System should retry failed messages
- Recovery rate should be high (≥95%)

### 6. Metrics Export (`metrics-export.stress.test.ts`)
Validates that stress test metrics are properly exported and consolidated.

**What it tests:**
- Metrics file generation
- Consolidated summary creation
- Metrics file structure validation

**Expected behavior:**
- Metrics files should be created in `test-results/`
- All required fields should be present
- Consolidated summary should aggregate results

## Running Stress Tests

### Run all stress tests:
```bash
npm run test:stress
```

### Run a specific stress test:
```bash
npm run test:stress -- --testNamePattern="High Volume"
```

### Run with verbose output:
```bash
npm run test:stress -- --verbose
```

## Metrics Output

Stress tests export metrics to the `test-results/` directory:

- `stress-high-volume-publish.json` - High volume publishing metrics
- `stress-high-speed-consume.json` - High speed consumption metrics
- `stress-metrics-summary.json` - Consolidated summary of all tests

### Metrics Structure

Each metrics file contains:
```json
{
  "throughput": 1234.56,        // messages per second
  "latencyAvg": 12.34,          // average latency in ms
  "latencyP50": 10.00,          // 50th percentile latency
  "latencyP95": 25.00,          // 95th percentile latency
  "latencyP99": 50.00,          // 99th percentile latency
  "memoryUsageMB": 45.67,       // memory usage in MB
  "cpuUsagePercent": 78.90,     // CPU usage percentage
  "errorRate": 0.12,            // error rate as percentage
  "totalMessages": 10000,       // total messages processed
  "totalErrors": 12,            // total errors encountered
  "duration": 8234              // test duration in ms
}
```

## Requirements

- Docker must be running (for RabbitMQ containers via Testcontainers)
- Sufficient system resources (memory, CPU)
- Node.js with `--expose-gc` flag for memory leak tests (optional but recommended)

## Timeouts

Stress tests have extended timeouts:
- Default test timeout: 5 minutes (300,000ms)
- Container startup: 60 seconds
- Container teardown: 30 seconds

## Best Practices

1. **Run stress tests separately** from unit/integration tests
2. **Monitor system resources** during test execution
3. **Review metrics** after each run to identify trends
4. **Run on dedicated hardware** for consistent results
5. **Compare metrics** across runs to detect regressions

## Troubleshooting

### Tests timeout
- Increase timeout in `jest.config.stress.js`
- Check Docker container health
- Verify system has sufficient resources

### High error rates
- Check RabbitMQ container logs
- Verify network connectivity
- Review system resource usage

### Memory leak false positives
- Run with `--expose-gc` flag: `node --expose-gc node_modules/.bin/jest`
- Increase memory threshold if legitimate growth
- Check for external factors (other processes)

### Container startup failures
- Ensure Docker is running
- Check Docker has sufficient resources
- Verify no port conflicts (5672, 15672)

## Performance Baselines

Expected performance (approximate, hardware-dependent):

- **Throughput**: 1000-5000 msg/s
- **Latency P95**: < 50ms
- **Latency P99**: < 100ms
- **Error Rate**: < 1%
- **Memory Growth**: < 50MB for 1000 messages

These are guidelines; actual performance depends on hardware, network, and system load.
