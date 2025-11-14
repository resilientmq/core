# Testing Documentation - @resilientmq/core

This directory contains the complete testing suite for @resilientmq/core, including unit tests, integration tests, stress tests, and benchmarks.

## Table of Contents

- [Overview](#overview)
- [Directory Structure](#directory-structure)
- [Prerequisites](#prerequisites)
- [Running Tests](#running-tests)
- [Test Types](#test-types)
- [Writing Tests](#writing-tests)
- [Interpreting Results](#interpreting-results)
- [Troubleshooting](#troubleshooting)

## Overview

The testing strategy for @resilientmq/core follows a multi-layered approach:

- **Unit Tests**: Fast, isolated tests with mocked dependencies
- **Integration Tests**: Tests with real RabbitMQ using Testcontainers
- **Stress Tests**: High-load scenarios to validate resilience
- **Benchmarks**: Performance measurements and regression detection

## Directory Structure

```
test/
├── unit/                          # Unit tests (fast, mocked)
│   ├── broker/                    # AMQPQueue tests
│   ├── logger/                    # Logger tests
│   └── resilience/                # Consumer, Publisher, DLQ tests
│
├── integration/                   # Integration tests (real RabbitMQ)
│   ├── consumer-publisher.integration.test.ts
│   ├── retry-logic.integration.test.ts
│   └── ...
│
├── stress/                        # Stress tests (high load)
│   ├── high-volume-publish.stress.test.ts
│   ├── memory-leak.stress.test.ts
│   └── ...
│
├── benchmark/                     # Performance benchmarks
│   ├── publish-throughput.bench.ts
│   ├── consume-throughput.bench.ts
│   └── ...
│
├── utils/                         # Shared test utilities
│   ├── test-containers.ts         # Testcontainers manager
│   ├── rabbitmq-helpers.ts        # RabbitMQ test helpers
│   ├── event-store-mock.ts        # EventStore mock
│   ├── amqplib-mock.ts            # amqplib mock
│   ├── test-data-builders.ts      # Test data builders
│   └── metrics-collector.ts       # Performance metrics
│
├── fixtures/                      # Test data and configurations
│   ├── events.ts                  # Sample events
│   ├── configs.ts                 # Test configurations
│   └── payloads.ts                # Sample payloads
│
├── jest.config.js                 # Base Jest configuration
├── jest.config.unit.js            # Unit tests configuration
├── jest.config.integration.js     # Integration tests configuration
├── jest.config.stress.js          # Stress tests configuration
├── jest.config.benchmark.js       # Benchmark tests configuration
├── setup.ts                       # Global Jest setup
└── README.md                      # This file
```

## Prerequisites

### For Unit Tests
- Node.js 18+ 
- npm dependencies installed (`npm install`)

### For Integration, Stress, and Benchmark Tests
- Docker installed and running
- Sufficient system resources (2GB+ RAM recommended)
- Port 5672 available (or Docker will assign random ports)

## Running Tests

### Quick Start

```bash
# Run all unit tests (fast, ~30 seconds)
npm run test:unit

# Run all integration tests (requires Docker, ~5 minutes)
npm run test:integration

# Run stress tests (requires Docker, ~10 minutes)
npm run test:stress

# Run benchmarks (requires Docker, ~15 minutes)
npm run test:benchmark

# Run all tests in sequence
npm run test:all

# Run tests with coverage report
npm run test:coverage

# Run tests in watch mode (development)
npm run test:watch
```

### Individual Test Files

```bash
# Run specific test file
npm run test:unit -- test/unit/broker/amqp-queue.test.ts

# Run tests matching pattern
npm run test:unit -- --testNamePattern="should publish message"

# Run with verbose output
npm run test:unit -- --verbose
```

## Test Types

### Unit Tests

**Purpose**: Validate individual components in isolation

**Characteristics**:
- Fast execution (< 5 seconds timeout per test)
- All external dependencies mocked
- No network calls or Docker containers
- High code coverage target (80%+)

**When to run**: During development, before every commit

**Example**:
```typescript
describe('ResilientConsumer', () => {
  it('should initialize with correct configuration', () => {
    const consumer = new ResilientConsumer(mockConfig);
    expect(consumer).toBeDefined();
  });
});
```

### Integration Tests

**Purpose**: Validate components working together with real RabbitMQ

**Characteristics**:
- Medium execution time (< 60 seconds timeout per test)
- Uses Testcontainers to spin up RabbitMQ
- Tests real message flow end-to-end
- Validates retry logic, DLQ, persistence

**When to run**: Before merging PRs, after integration changes

**Example**:
```typescript
describe('Integration: Publisher-Consumer Flow', () => {
  beforeAll(async () => {
    await containerManager.startRabbitMQ();
  });

  it('should publish and consume message end-to-end', async () => {
    await publisher.publish(testEvent);
    await waitForMessages(queue, 1);
    expect(processedEvents).toHaveLength(1);
  });
});
```

### Stress Tests

**Purpose**: Validate system behavior under extreme load

**Characteristics**:
- Long execution time (< 5 minutes timeout per test)
- High message volumes (10,000+ messages)
- Memory leak detection
- Concurrent consumer scenarios
- Error rate validation (< 1%)

**When to run**: Before releases, during performance optimization

**Example**:
```typescript
it('should handle 10,000 concurrent messages', async () => {
  const promises = Array.from({ length: 10000 }, (_, i) =>
    publisher.publish(createTestEvent(i))
  );
  await Promise.all(promises);
  expect(metrics.errorRate).toBeLessThan(1);
});
```

### Benchmarks

**Purpose**: Measure and track performance metrics

**Characteristics**:
- Very long execution time (< 15 minutes timeout)
- Multiple iterations for statistical significance (5+)
- Generates JSON reports for comparison
- Tracks throughput, latency (P50, P95, P99)
- Detects performance regressions

**When to run**: Before releases, during optimization work

**Example**:
```typescript
it('should measure publish throughput', async () => {
  const collector = new MetricsCollector();
  collector.start();
  
  for (let i = 0; i < 1000; i++) {
    await publisher.publish(createTestEvent(i));
  }
  
  const metrics = collector.stop();
  console.log(`Throughput: ${metrics.throughput} msg/s`);
});
```

## Writing Tests

### Test Structure

Follow the Arrange-Act-Assert pattern:

```typescript
describe('ComponentName', () => {
  let component: Component;
  let mockDependency: MockDependency;
  
  beforeEach(() => {
    // Arrange: Set up test environment
    mockDependency = new MockDependency();
    component = new Component(mockDependency);
  });
  
  afterEach(() => {
    // Cleanup
    jest.clearAllMocks();
  });
  
  it('should do something', async () => {
    // Arrange: Prepare test data
    const input = { foo: 'bar' };
    
    // Act: Execute the code under test
    const result = await component.doSomething(input);
    
    // Assert: Verify the outcome
    expect(result).toBe(expected);
    expect(mockDependency.method).toHaveBeenCalledWith(input);
  });
});
```

### Using Test Utilities

```typescript
import { EventBuilder } from '../utils/test-data-builders';
import { EventStoreMock } from '../utils/event-store-mock';
import { TestContainersManager } from '../utils/test-containers';

// Build test data
const event = new EventBuilder()
  .withType('user.created')
  .withPayload({ userId: '123' })
  .build();

// Use mocks
const storeMock = new EventStoreMock();
storeMock.setFailOnSave(true); // Simulate failure

// Use Testcontainers
const containerManager = new TestContainersManager();
await containerManager.startRabbitMQ();
const connectionUrl = containerManager.getConnectionUrl();
```

### Best Practices

1. **Keep tests focused**: One concept per test
2. **Use descriptive names**: `should publish message to correct queue when routing key matches`
3. **Clean up resources**: Always use `afterEach`/`afterAll` for cleanup
4. **Avoid test interdependence**: Each test should run independently
5. **Use fixtures**: Reuse common test data from `fixtures/`
6. **Mock external dependencies**: Only integration tests use real services
7. **Test error cases**: Don't just test happy paths

## Interpreting Results

### Coverage Reports

After running `npm run test:coverage`, open `coverage/index.html` in a browser.

**Coverage Thresholds**:
- Lines: 80%+
- Branches: 75%+
- Functions: 80%+
- Statements: 80%+

### Stress Test Metrics

Stress tests generate `test-results/stress-metrics.json`:

```json
{
  "throughput": 1250.5,
  "latencyAvg": 12.3,
  "latencyP50": 10.5,
  "latencyP95": 25.8,
  "latencyP99": 45.2,
  "memoryUsageMB": 125.4,
  "cpuUsagePercent": 45.2,
  "errorRate": 0.5,
  "totalMessages": 10000,
  "duration": 8000
}
```

**What to look for**:
- Error rate < 1%
- Memory usage stable (no continuous growth)
- Throughput meets requirements
- Latency P99 < 100ms

### Benchmark Results

Benchmarks generate individual JSON files in `test-results/`:

```json
{
  "avgThroughput": 1500.2,
  "avgLatency": 10.5,
  "results": [
    { "throughput": 1520, "latencyAvg": 10.2 },
    { "throughput": 1480, "latencyAvg": 10.8 }
  ]
}
```

**Regression Detection**:
- Compare with baseline results
- Alert if throughput drops > 10%
- Alert if latency increases > 10%

## Troubleshooting

### Docker Issues

**Problem**: Integration tests fail with "Cannot connect to Docker"

**Solution**:
```bash
# Check Docker is running
docker ps

# On Windows, ensure Docker Desktop is running
# On Linux, ensure Docker daemon is running
sudo systemctl start docker
```

**Problem**: Port conflicts (address already in use)

**Solution**: Testcontainers automatically assigns random ports. If issues persist:
```bash
# Stop all containers
docker stop $(docker ps -aq)

# Remove all containers
docker rm $(docker ps -aq)
```

### Memory Issues

**Problem**: Tests fail with "JavaScript heap out of memory"

**Solution**:
```bash
# Increase Node.js memory limit
export NODE_OPTIONS="--max-old-space-size=4096"
npm run test:stress
```

### Timeout Issues

**Problem**: Tests timeout before completing

**Solution**:
- Check Docker has sufficient resources (2GB+ RAM)
- Increase timeout in specific test: `it('test', async () => {...}, 120000)`
- Check RabbitMQ container is healthy: `docker ps`

### Flaky Tests

**Problem**: Tests pass sometimes, fail other times

**Common causes**:
- Race conditions (use proper `await` and `waitFor` helpers)
- Insufficient cleanup (check `afterEach` hooks)
- Shared state between tests (ensure test isolation)
- Timing issues (use `waitForMessages` instead of fixed delays)

**Debugging**:
```bash
# Run test multiple times
npm run test:integration -- --testNamePattern="flaky test" --runInBand

# Enable verbose logging
DEBUG=* npm run test:integration
```

### Coverage Not Meeting Threshold

**Problem**: Coverage below 80%

**Solution**:
1. Run coverage report: `npm run test:coverage`
2. Open `coverage/index.html` to see uncovered lines
3. Add tests for uncovered code paths
4. Focus on critical business logic first

### Testcontainers Slow Startup

**Problem**: Integration tests take long to start

**Explanation**: First run downloads RabbitMQ image (~200MB)

**Solution**:
```bash
# Pre-pull the image
docker pull rabbitmq:3.12-management

# Subsequent runs will be faster
```

## CI/CD Integration

Tests are designed to run in CI/CD pipelines:

```yaml
# Example GitHub Actions workflow
jobs:
  unit-tests:
    runs-on: ubuntu-latest
    steps:
      - run: npm run test:unit
      - run: npm run test:coverage
  
  integration-tests:
    runs-on: ubuntu-latest
    steps:
      - run: npm run test:integration
```

## Additional Resources

- [Jest Documentation](https://jestjs.io/docs/getting-started)
- [Testcontainers Documentation](https://testcontainers.com/)
- [RabbitMQ Testing Guide](https://www.rabbitmq.com/testing.html)

## Support

For issues or questions:
- Check existing tests for examples
- Review this documentation
- Open an issue on GitHub
