# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.2] - 2025-11-14

### Fixed

- **Dead Letter Queue (DLQ) Routing**: Fixed critical issue where messages that exceeded maximum retry attempts were not being routed to the DLQ
  - Messages now correctly reach the DLQ after exhausting all retry attempts
  - Implemented manual DLQ publishing when max attempts are exceeded to bypass RabbitMQ DLX limitations
  - Added proper routing key handling for DLQ exchanges
  - Enhanced error headers in DLQ messages with detailed failure information (`x-error-message`, `x-error-name`, `x-error-stack`, `x-death-count`, `x-death-time`, `x-original-queue`)
  - Messages are now ACK'd after being sent to DLQ (preventing infinite retry loops)

### Changed

- **Processor Behavior on Max Attempts**: When a message exceeds `maxAttempts`, the processor now:
  1. Updates event status to `ERROR` in the store
  2. Calls the `onError` hook
  3. Manually publishes the message to the DLQ (if configured)
  4. ACKs the original message (instead of throwing an error)
  - This ensures messages don't get stuck in the retry queue indefinitely

### Technical Details

- Modified `ResilientEventConsumeProcessor` to handle DLQ routing manually when max attempts are exceeded
- Fixed routing key propagation for DLQ exchanges
- Aligned DLQ publishing pattern with `dlq-handler` implementation for consistency
- Updated unit tests to reflect new behavior (no error thrown when DLQ is configured and max attempts exceeded)

## [1.2.1] - 2025-11-14

### Added

- **CI/CD Pipeline Unification**: Merged separate test and publish workflows into a single comprehensive CI/CD pipeline
  - Unified workflow with proper job dependencies and conditional execution
  - Added path filters to only run workflow on relevant file changes (`src/`, `test/`, `package.json`, `tsconfig.json`)
  - Expanded Node.js version matrix to include Node.js 24
  - Improved workflow organization with clear job separation (unit tests, integration tests, stress tests, benchmarks, build, publish)

- **Static Badges**: Added informative badges to README for quick project status overview
  - CI/CD status badge
  - npm version badge
  - Node.js versions badge (18, 20, 22, 24)
  - TypeScript badge
  - License badge

### Fixed

- **Timer Cleanup**: Fixed open handles in tests by properly tracking and cleaning up `idleMonitorTimer` in `ResilientConsumer`
  - Added `idleMonitorTimer` property to track the idle monitor interval
  - Ensured timer is cleared in `stopTimers()` method
  - Resolved Jest `--detectOpenHandles` warnings

- **Benchmark Tests**: Fixed multiple issues in benchmark tests
  - Corrected handler signature mismatch (handlers receive `EventMessage` object, not just payload)
  - Fixed duplicate detection issue by removing store from publisher in persistence benchmarks
  - Fixed queue creation timing by ensuring consumer starts before publishing messages
  - Updated imports to include `EventMessage` type

### Changed

- **Jest Configuration**: All Jest configs now include `detectOpenHandles: true` by default for better test hygiene
- **Workflow Optimization**: Reduced unnecessary workflow runs through intelligent path filtering
- **Documentation**: Updated workflow documentation in `.github/README.md`

### Removed

- Removed separate `test.yml` and `publish.yml` workflow files (consolidated into `ci-cd.yml`)
- Removed dynamic badge implementation in favor of simpler static badges

## [1.2.0] - 2025-11-14

### Added

#### Comprehensive Testing Infrastructure

- **Complete Test Suite**: Implemented a comprehensive automated testing strategy covering all aspects of the library
  - **Unit Tests**: Fast, isolated tests for all core components with mocked dependencies
  - **Integration Tests**: End-to-end tests with real RabbitMQ using Testcontainers
  - **Stress Tests**: High-volume and high-speed testing to validate system resilience under load
  - **Benchmark Tests**: Performance measurement and regression detection

- **Test Utilities and Helpers**:
  - `TestContainersManager`: Manages Docker containers for integration tests
  - `RabbitMQHelpers`: Utilities for RabbitMQ operations in tests (purge, peek, wait for messages)
  - `EventStoreMock`: In-memory EventStore implementation for unit tests
  - `AMQPLibMock`: Complete mock of amqplib for isolated unit testing
  - `TestDataBuilders`: Builder pattern for creating test data (EventBuilder, ConsumerConfigBuilder, PublisherConfigBuilder)
  - `MetricsCollector`: Collects performance metrics during stress and benchmark tests

- **Test Coverage**:
  - Unit tests for all core components: ResilientConsumer, ResilientEventPublisher, AMQPQueue, DLQHandler, Middleware, Logger
  - Integration tests for: consumer-publisher flow, retry logic, DLQ routing, persistence, reconnection, multi-exchange scenarios
  - Stress tests for: high-volume publishing (10,000+ messages), high-speed consumption, memory leak detection, concurrent consumers, recovery under load
  - Benchmarks for: publish throughput, consume throughput, end-to-end latency, store overhead, middleware impact

- **CI/CD Integration**:
  - **GitHub Actions Workflow** (`.github/workflows/test.yml`):
    - Unit tests job with coverage validation (70% minimum threshold)
    - Integration tests job with RabbitMQ service
    - Stress tests job (runs on pull requests only)
    - Benchmarks job (runs on main/master branch only)
    - Test summary job for quick status overview
  - **Matrix Testing**: All tests run across Node.js 18, 20, and 22 for compatibility validation
  - **Quality Gates**:
    - Build fails if coverage < 70%
    - Build fails if any test fails
    - Build fails if benchmark regression > 10%
    - Stress tests must maintain error rate < 1%

- **Performance Optimization**:
  - npm dependency caching for faster builds
  - Jest cache for improved test execution speed
  - Parallel test execution across Node versions (reduces CI time by ~60%)
  - Conditional job execution (stress tests on PRs, benchmarks on main branch)
  - Optimized Jest worker configuration (50% CPU cores for unit tests)

- **Quality Assurance Scripts**:
  - `check-coverage.js`: Validates code coverage meets minimum thresholds
  - `compare-benchmarks.js`: Detects performance regressions by comparing against baseline
  - `generate-benchmark-report.ts`: Generates detailed benchmark reports

- **Documentation**:
  - `test/README.md`: Comprehensive testing documentation
  - `.github/README.md`: CI/CD workflow documentation
  - `.github/CI-OPTIMIZATION.md`: Detailed CI optimization guide
  - Test setup and configuration guides

### Changed

- **Jest Configurations**: Enhanced with proper timeouts, coverage thresholds, and caching
  - Unit tests: 5 second timeout, 70%+ coverage requirement
  - Integration tests: 60 second timeout, serial execution
  - Stress tests: 5 minute timeout, serial execution
  - Benchmark tests: 15 minute timeout, serial execution
  - All configurations now use Jest cache for improved performance

- **Package Scripts**: Added comprehensive test and quality check scripts
  - `test:unit`: Run unit tests
  - `test:integration`: Run integration tests with RabbitMQ
  - `test:stress`: Run stress tests
  - `test:benchmark`: Run performance benchmarks
  - `test:all`: Run all test suites sequentially
  - `test:coverage`: Run unit tests with coverage report
  - `coverage:check`: Validate coverage thresholds
  - `benchmark:compare`: Compare benchmarks against baseline
  - `benchmark:report`: Generate benchmark reports
  - `quality:check`: Run all quality checks

### Technical Improvements

- **Test Organization**: Clear separation of test types in dedicated directories
- **Reusable Test Infrastructure**: Shared utilities, fixtures, and helpers across all test types
- **Automated Quality Enforcement**: CI pipeline ensures code quality and performance standards
- **Performance Monitoring**: Continuous tracking of throughput, latency, and resource usage
- **Regression Detection**: Automated detection of performance and functionality regressions
- **Multi-Version Compatibility**: Validated compatibility across multiple Node.js versions

### Quality Metrics

- **Code Coverage**: 70%+ minimum threshold enforced
- **Test Execution Time**: 
  - Unit tests: < 30 seconds
  - Integration tests: < 5 minutes
  - Stress tests: < 10 minutes
  - Benchmarks: < 15 minutes
- **CI Pipeline Time**: ~12 minutes total (73% reduction from unoptimized baseline)
- **Performance Standards**: 
  - Error rate under load: < 1%
  - Benchmark regression tolerance: < 10%
  - No memory leaks detected

## [1.0.1] - 2025-11-13

### Added

#### Configuration Options
- **`instantPublish` in ResilientPublisherConfig**: Controls whether events are published immediately or stored for later
  - Default: `true` (events are published immediately)
  - When `false`, events are only stored and sent via `processPendingEvents()` or periodic check
  - When `false`, a store with `getPendingEvents()` method is REQUIRED
  - `pendingEventsCheckIntervalMs` only takes effect when `instantPublish` is `false`

- **Store Connection Management**:
  - Added `storeConnectionRetries` option (default: 3) for both Consumer and Publisher
  - Added `storeConnectionRetryDelayMs` option (default: 1000ms) for both Consumer and Publisher
  - Automatic store connection verification on startup with retry logic
  - Consumer and Publisher will fail initialization if store is configured but connection fails
  - Health check mechanism for store connections before operations

#### Enhanced Logging System
- Added timestamps to all log messages for better debugging
- New `setLogTimestamps()` function to enable/disable timestamps
- Improved log message formatting and consistency
- Better structured logging for all operations
- More detailed error messages with context

#### Validation & Error Handling
- **Publisher Validations**:
  - Error thrown if `instantPublish` is `false` but no `store` is configured
  - Error thrown if `instantPublish` is `false` but `store.getPendingEvents()` is not implemented
  - Warning logged if `pendingEventsCheckIntervalMs` is set but `instantPublish` is `true`
  - Error thrown if neither `queue` nor `exchange` is configured
  
- **Consumer Validations**:
  - Error thrown if `consumeQueue.queue` is not configured
  - Error thrown if `eventsToProcess` is empty or not provided
  - Store connection verification before consumer starts

### Changed

- **EventStore Interface**:
  - `getPendingEvents()` method is now optional in TypeScript
  - Required only when using Publisher with `instantPublish: false`
  - Better type safety and clearer API contracts

- **Publisher Behavior**:
  - When `instantPublish` is `true` (default), behaves as before (immediate publish)
  - When `instantPublish` is `false`, events are only stored until processed
  - Store connection is verified before any operation
  - Better error messages and logging throughout

- **Consumer Behavior**:
  - Store connection is verified during startup if store is configured
  - Consumer fails to start if store connection cannot be established
  - Improved error handling and logging

### Fixed

- Store connection issues now properly detected and handled
- Configuration validation happens before any operations begin
- Better error messages when configuration is invalid
- Prevented silent failures when store operations fail

### Technical Improvements

- Centralized configuration validation in constructors
- Better separation of concerns between instant and deferred publishing
- Improved code documentation and inline comments
- Enhanced type safety with better TypeScript definitions
- Consistent error handling patterns across Publisher and Consumer

## [1.0.0] - 2025-11-11

### Added

#### Core Features
- **ResilientConsumer**: Robust consumer with retry and dead-letter queue support
  - Automatic retry mechanism with configurable attempts and delays
  - Dead letter queue for permanently failed messages
  - Support for message deduplication
  - Event lifecycle tracking (PENDING, PROCESSING, DONE, RETRY, ERROR, DEAD_LETTER)
  - Configurable prefetch and connection management
  - Health monitoring and automatic reconnection
  - Idle detection with configurable exit strategy
  - Support for ignoring unknown event types
  
- **ResilientEventPublisher**: Safe event publishing with persistence
  - Pre-publish event storage for guaranteed delivery
  - Status tracking (PENDING, PUBLISHED, ERROR)
  - Support for both queue and exchange publishing
  - Duplicate message detection
  - Optional store (can work without persistence)
  - **Pending Events Processing**: Periodic checking and processing of pending events
    - New configuration option `pendingEventsCheckIntervalMs` to enable automatic processing at configurable intervals
    - Events are automatically sorted and sent in chronological order (oldest first)
    - Only connects to RabbitMQ when there are actually pending events to process
  - **Store-Only Publishing**: Added `storeOnly` option to `publish()` method
    - Allows storing events for later delivery without immediately sending them
    - Useful for offline scenarios or batch processing
  - **Publisher Control Methods**:
    - `processPendingEvents()`: Manually trigger processing of pending events
    - `stopPendingEventsCheck()`: Stop the periodic checking interval for graceful shutdown

- **Multiple Exchange Bindings**: Support for binding a consume queue to multiple exchanges
  - Updated `consumeQueue` configuration to accept `exchanges` array instead of single `exchange`
  - Allows consuming from multiple exchanges with different routing keys
  - Each exchange can have its own routing key and configuration

- **Enhanced Dead Letter Queue Handling**:
  - Added error details storage when messages are sent to DLQ
  - Support for additional exchange bindings in DLQ configuration
  - Improved error tracking and debugging capabilities

- **Middleware System**: Pluggable middleware pipeline for event processing
  - Pre and post-processing hooks
  - Error handling middleware
  - Event transformation capabilities

- **Event Store Interface**: Flexible persistence layer
  - `saveEvent()`: Store new events
  - `getEvent()`: Retrieve events by ID
  - `updateEventStatus()`: Update event lifecycle status
  - `deleteEvent()`: Remove processed events
  - `getPendingEvents()`: Retrieve all events with a specific status for batch processing
  - Optional implementation (consumer and publisher can work without store)

- **AMQP Queue Management**:
  - Connection pooling and management
  - Exchange and queue assertion
  - Automatic reconnection on failures
  - Support for all RabbitMQ exchange types (direct, topic, fanout, headers)

- **Lifecycle Hooks**: Event processing callbacks
  - `onEventStart`: Triggered before processing (with event skip control)
  - `onSuccess`: Triggered after successful processing
  - `onError`: Triggered on processing errors

- **Comprehensive TypeScript Support**:
  - Full type definitions for all APIs
  - Generic event payload typing
  - Type-safe configuration objects

- **Logging System**: Built-in logging with configurable levels
  - Support for info, warn, error, and debug levels
  - Structured logging for better monitoring

### Changed
- Enhanced `ResilientEventPublisher` constructor to initialize periodic event checking if configured
- Improved logging to avoid spam when no pending events are found during periodic checks
- Event ordering is now centralized in the publisher rather than delegated to the EventStore
- Consumer and Publisher now support optional store configuration
- Per-message routing keys are now taken from each `EventMessage.routingKey` field when publishing

### Technical Details
- Pending events are sorted by `properties.timestamp` in ascending order
- The periodic check uses `setInterval` with configurable interval in milliseconds
- Error handling improved for periodic checks to prevent unhandled promise rejections
- Store is now optional in both consumer and publisher configurations

### Configuration Options
- **Consumer**:
  - Connection strings or detailed connection objects
  - Queue and exchange configuration with multiple exchange support
  - Retry policies with TTL and max attempts
  - Health check intervals and timeouts
  - Unknown event handling policies
  - Optional event store
  
- **Publisher**:
  - Connection configuration
  - Queue or exchange targeting
  - Optional event store for persistence
  - Configurable pending events check interval

---

## Migration Guide

### EventStore Implementation

If you're implementing an EventStore, add the new `getPendingEvents()` method:

```typescript
async getPendingEvents(status: EventPublishStatus): Promise<EventMessage[]> {
    // Return events with the specified status
    // No need to sort them - the publisher handles ordering automatically
    return await this.findByStatus(status);
}
```

### Pending Events Processing

To enable automatic pending event processing:

```typescript
const config: ResilientPublisherConfig = {
    connection: 'amqp://localhost',
    store: myEventStore,
    // Check for pending events every 30 seconds
    pendingEventsCheckIntervalMs: 30000
};
```

### Store-Only Publishing

To store events without sending them immediately:

```typescript
await publisher.publish(event, { storeOnly: true });
```

### Multiple Exchange Bindings

Update your consumer configuration to use multiple exchanges:

```typescript
consumeQueue: {
    queue: 'my-queue',
    exchanges: [
        { name: 'exchange-1', type: 'topic', routingKey: 'events.*' },
        { name: 'exchange-2', type: 'direct', routingKey: 'notification' }
    ]
}
```

## [0.3.3] - 2025-10-22
### Changed
- Publisher now reads the routing key from each event's `routingKey` field when publishing to an exchange. The exchange configuration is no longer used to supply a per-message routing key. If an event does not specify `routingKey`, the publisher will publish without a routing key (empty string), allowing the broker and bindings to determine delivery.
- Updated API: `EventMessage` now includes an optional `routingKey?: string` field. (See README and types)

## [0.3.0] - 2025-10-02
### Changed
- Enhanced retry and dead-letter queue handling: refactored retry flow and improved DLQ publishing and routing. (commit f899f7b, 2025-10-02)
- Corrected dead letter routing key handling and updated package versions. (commit c6c9804, 2025-10-02)
- Improved overall queue handling and processing flow. (commit ec9fc1b, 2025-10-02)
- Added richer error details and additional exchange bindings for DLQ handling. (commit ff50cd5, 2025-10-01)
- Updated `consumeQueue` configuration to support multiple exchanges. (commit 3bb99fd, 2025-10-01)

## [0.2.9] - 2025-10-02
### Fixed
- Enhanced retry logic with improved dead-letter handling. (commit 3b47b2d, 2025-10-02)

## [0.2.8] - 2025-10-02
### Fixed
- Refactored retry and dead-letter queue handling as part of a version bump to 0.2.8. (commit 938347e, 2025-10-02)

## Earlier history (2025-05-16 → 2025-06-13)
These entries summarize the initial development and subsequent fixes before the 0.2.8+ series.

### Added
- Initial project scaffolding and library upload. (commits e93dbed, 0ca797d, c737838, 95d1fa1)
- Added configuration options and interfaces (more properties, updated types/interfaces). (commit 51b52b1)
- Added `skipEvent` control for starting events and configuration to ignore unknown events. (commits dbd4670, 8850af7)
- Added support for waiting for messages being processed. (commit 243e3fa)

### Changed
- Switched `.d.ts` artifacts to `.ts` and reorganized types directory. (commits d2e47d9, 951760c, 437df98)
- Updated package.json and workflow files. (commits 1af7f27, e850f3e, ca09444)
- Minor code and typo fixes across the codebase. (commits 5801155, c42c501)

### Fixed
- Multiple fixes to consumer/publisher flow, queue declaration and binding order. (commits 9a5606c, 5fd604c, 02ebd98, 475a971)
- Retry and x-death count handling fixes. (commits cacc253, 2f1ada0, 194de62)
- Stability improvements for consumer attempts and connection handling (made connection methods private and more robust). (commits 0534d85, f43f0e2)
- Type fixes and removal of unnecessary dependencies. (commits fb7b020, e95ed7e)


---

For more information, visit the [GitHub repository](https://github.com/resilientmq/core).

