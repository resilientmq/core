# [2.2.4] - 2026-04-09

### Added

- **Consumer config**: Added `cleanupConsumerPrefetch` for the secondary cleanup connection used with `ignoreUnknownEvents`.
  - Default: `500`
  - Set to `0` to disable cleanup functionality

### Changed

- **Unknown events path**: Consumer now suppresses processor-level unknown-event discard errors so they are not rethrown to the queue layer.
- **Max retry exceeded path**: Consumer now suppresses `max retry attempts exceeded` errors from the processor callback to avoid unintended retry requeueing.

### Fixed

- **Retry pollution**: Prevented unknown/ignored events and max-retry-exceeded guard cases from being treated as processing failures by the queue callback.

# [2.2.3] - 2026-04-09

### Changed

- **Core performance (no logic change)**: Applied low-risk micro-optimizations across core modules to reduce repeated lookups and allocations in hot paths.
  - `ResilientConsumer`, `ResilientEventConsumeProcessor`, `ResilientEventPublisher`, `AmqpQueue`, `DLQ handler`, `middleware`, `logger`, and `metrics collector` were refactored internally for lower overhead.
  - Kept resilient behavior and event-processing semantics intact.

- **Consumer logging behavior**: `Consuming from:` is now emitted only once per consumer instance (avoids repeated noise on reconnect cycles).

- **Unknown event fast-discard**: When `ignoreUnknownEvents` is enabled, unknown events are discarded immediately through the non-requeue path.

### Fixed

- **Security**: Updated transitive `lodash` to a safe version via `overrides` (`^4.18.1`) to resolve audit vulnerabilities.

- **Test stability/noise**: Improved global test setup listener handling to avoid repeated process-level registrations and suppress `MaxListenersExceededWarning` noise during test runs.

- **Integration cleanup robustness**: Hardened integration test cleanup paths with defensive teardown calls to avoid secondary errors when setup fails.

- **Integration runner resilience**: Added runtime pre-check wrapper for integration tests to skip cleanly when Docker/Testcontainers runtime is unavailable.

# [2.2.0] - 2026-03-31

### Added

- **Connection Pool**: Publisher now supports multiple RabbitMQ connections for load distribution
  - New `maxConnections` configuration parameter (default: 1)
  - Round-robin distribution strategy across connection pool
  - Improves throughput by distributing load across multiple connections
  - All connections are managed automatically (connect/disconnect/recovery)
  - Backward compatible - defaults to single connection behavior

### Changed

- **Publisher Architecture**: Refactored from single connection to connection pool
  - Changed from `queue: AmqpQueue` to `connectionPool: AmqpQueue[]`
  - Added `getNextConnection()` method for round-robin selection
  - Updated `connect()` to connect all connections in pool using `Promise.all()`
  - Updated `disconnect()` to disconnect all connections in pool
  - Updated `publishToBroker()` to use `getNextConnection()` for load distribution
  - Updated `recoverBrokerConnection()` to accept specific queue parameter

### Migration Notes

No breaking changes. To use connection pooling, simply add `maxConnections` to your publisher config:

```typescript
const publisher = new ResilientEventPublisher({
  connection: 'amqp://localhost',
  exchange: { name: 'events', type: 'topic' },
  maxConnections: 5  // Use 5 connections for load distribution
});
```

# [2.1.5] - 2026-03-31

### Changed

- **Publisher (`processPendingEvents`)**: Restored rate limiting functionality from version 2.1.2
  - Re-implemented token bucket algorithm for controlled throughput
  - Added back `maxPublishesPerSecond` and `maxConcurrentPublishes` parameters to `ProcessPendingEventsOptions`
  - Removed automatic sorting of events by timestamp - events are now processed in the order returned by the store
  - Maintains batch status updates for optimal performance

### Added

- **Configuration validation**: Added validation for `pendingEventsMaxPublishesPerSecond` and `pendingEventsMaxConcurrentPublishes` in publisher config

### Removed

- **Event sorting**: Removed automatic chronological sorting in `processPendingEvents()` - the store is now responsible for returning events in the desired order

### Migration Notes

If you need events processed in chronological order, ensure your `EventStore.getPendingEvents()` implementation returns events sorted by timestamp:

```typescript
async getPendingEvents(status: EventPublishStatus, limit?: number): Promise<EventMessage[]> {
  const query = EventModel.find({ status }).sort({ createdAt: 1 }); // Sort by creation time
  return limit ? query.limit(limit).exec() : query.exec();
}
```

# [2.1.4] - 2026-03-31

### Changed

- **Publisher (`processPendingEvents`)**: Simplificado para máxima velocidad - eliminado rate limiting artificial
  - Procesa todos los eventos del batch en paralelo con `Promise.allSettled()` - máxima concurrencia
  - Actualización de estados en batch después de publicar todos los eventos
  - Eliminado algoritmo de token bucket que limitaba el rendimiento
  - Eliminados parámetros `maxPublishesPerSecond` y `maxConcurrentPublishes` de `processPendingEvents()`
  - Solo queda `batchSize` como parámetro - controla cuántos eventos se leen del store por iteración
  - **Resultado**: Velocidad máxima sin limitaciones artificiales, solo limitado por RabbitMQ y el store

### Performance

- **10-100x más rápido**: Sin rate limiting artificial, procesa a la velocidad máxima del sistema
- **Paralelismo total**: Todos los eventos del batch se publican simultáneamente
- **Batch updates**: Una sola llamada al store por batch para actualizar todos los estados
- **Simplicidad**: Código más simple y mantenible sin complejidad innecesaria

### Breaking Changes

- **`ProcessPendingEventsOptions`**: Eliminados `maxPublishesPerSecond` y `maxConcurrentPublishes`
  - Solo queda `batchSize` (opcional, default: 100)
  - Migración: Simplemente elimina esos parámetros de tus llamadas

# [2.2.0] - 2026-03-30

### Added

- **IgnoredEventError**: New error that can be thrown from an event handler to ignore the event and mark it as successfully processed (`DONE`), with no retries or DLQ.
- **Consumer**: If a handler throws `IgnoredEventError`, the event is marked as `DONE` and will not be retried or sent to the DLQ.
- **Tests**: Added unit test for this behavior.
- **Docs**: Documented the usage of `IgnoredEventError` in the README.

# [2.1.2] - 2026-03-31

### Added

- **Publisher (`EventStore`)**: New optional `batchUpdateEventStatus()` method for batch status updates
  - Reduces store overhead from 1000 individual calls/s to ~10 batched calls/s (100ms batching window)
  - Backward compatible - method is optional, falls back to individual updates if not implemented
  - Significantly improves performance when processing large volumes of pending events

### Changed

- **Publisher (`processPendingEvents`)**: Implemented token bucket algorithm for proper rate limiting
  - Replaced fixed 1-second windows with continuous token refill for smoother throughput
  - Can now achieve 500-1000 msg/s with proper configuration (previously stuck at ~44 msg/s)
  - New method `processEventsWithRateLimit` handles concurrent processing with accurate rate limits
  - Removed old `runWithConcurrency` method (no longer needed)

### Fixed

- **Publisher (`processPendingEvents`)**: Fixed rate limiting that was stuck at ~44 msg/s regardless of configuration
  - Token bucket algorithm now properly respects `maxPublishesPerSecond` parameter
  - Concurrent processing with `maxConcurrentPublishes` now works correctly with rate limiting

### Performance

- **10-20x throughput improvement**: From ~44 msg/s to 500-1000 msg/s capability
- **90% reduction in store calls**: Batch updates reduce overhead dramatically
- **Better resource utilization**: Token bucket allows burst capacity while maintaining average rate

# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.1.0] - 2026-03-27

### Added

- **Publisher (`processPendingEvents`)**: Added per-call throughput controls via `ProcessPendingEventsOptions`
  - `batchSize?: number`
  - `maxPublishesPerSecond?: number`
  - `maxConcurrentPublishes?: number`

- **Publisher Config**: Added optional defaults for pending events processing
  - `maxConcurrentPublishes`
  - `pendingEventsBatchSize`
  - `pendingEventsMaxPublishesPerSecond`
  - `pendingEventsMaxConcurrentPublishes`

### Changed

- **Publisher (`processPendingEvents`)**: Pending events processing is now configurable and throughput-oriented
  - Fetch size is no longer fixed at 10 events
  - Pending events can now be dispatched with bounded parallelism
  - Dispatch rate can now be limited by publishes-per-second to avoid overwhelming RabbitMQ channels
  - Constructor-level defaults can be overridden per `processPendingEvents()` call

- **Publisher (`processPendingEvents`)**: Pending events are still fetched and scheduled oldest-first within each batch, while allowing higher throughput for large backlogs

### Fixed

- **Publisher (broker recovery under load)**: Coordinated concurrent reconnect attempts through a shared recovery flow, preventing reconnect storms and reducing cascading `Channel closed` / `Channel ended` failures during high-throughput pending processing

- **Publisher (high-throughput idle handling)**: Preserved idle-disconnect lifecycle while processing pending events at higher rates

## [2.0.1] - 2026-03-16

### Fixed

- **Security**: Updated `undici` to `^7.24.3` via `overrides` to resolve three CVEs affecting the transitive dependency from `testcontainers`:
  - Malicious WebSocket 64-bit length overflow crashing the client (High)
  - HTTP Request/Response Smuggling (Moderate)
  - CRLF Injection via `upgrade` option (Moderate)

### Changed

- **CI/CD Workflow**: Consolidated three separate workflow files (`ci.yml`, `publish.yml`, `stress-benchmarks.yml`) into a single `ci-cd.yml` pipeline
  - Enforces sequential execution: unit tests → integration tests → stress & benchmarks → build → publish
  - Added `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: true` to resolve Node.js 20 deprecation warnings in GitHub Actions
  - Added Node.js 25 to the test matrix

## [2.0.0] - 2026-03-16

### Added

- **Metrics System**: New `MetricsCollector` class and `ResilientMQMetrics` interface, exported from the main index
  - Enable per-consumer/publisher metrics with `metricsEnabled: true` in config
  - Access real-time snapshots via `consumer.getMetrics()` / `publisher.getMetrics()`
  - Tracks: `messagesReceived`, `messagesProcessed`, `messagesRetried`, `messagesFailed`, `messagesSentToDLQ`, `messagesPublished`, `processingErrors`, `avgProcessingTimeMs`, `lastActivityAt`
  - `MetricsCollector` is also exported for standalone use

- **Graceful Shutdown**: `ResilientConsumer` now handles shutdown correctly when messages are in-flight
  - `stop()` waits for all in-flight handlers and pending acks/nacks before closing the AMQP connection
  - SIGTERM and SIGINT signals are handled automatically after `start()` — no manual wiring needed
  - RETRY events in the store are reverted to ERROR on shutdown to prevent stale retry state

- **AmqpQueue — `pendingAcks` counter**: New public getter tracks ack/nack calls sent but not yet confirmed, enabling accurate shutdown coordination

- **AmqpQueue — `waitForProcessing()`**: New public method that resolves only when both `processingMessages` and `pendingAcks` reach zero

- **AmqpQueue — `forceClose()`**: New method that forcefully cleans up dead or stale connections without waiting for in-flight messages

- **EventStore — `getEventsByStatus()`**: Optional method added to the `EventStore` interface, used by the consumer to find and revert RETRY events on shutdown

### Changed

- **amqplib**: Updated to `^0.10.9` (latest), `@types/amqplib` to `^0.10.8`

- **Coverage**: Achieved 100% across all metrics (Statements, Branches, Functions, Lines) — 297 unit tests, all passing

- **CI/CD Workflow**: Reorganized from a single monolithic file into three focused workflows
  - `ci.yml` — unit tests (Node 18/20/22/24), integration tests, build, and coverage summary
  - `stress-benchmarks.yml` — stress tests and performance benchmarks (runs on push to main)
  - `publish.yml` — NPM publish with automatic git tagging (runs on push to master)

- **Source Code**: Cleaned up and reorganized all source files for consistency and readability

### Fixed

- **Publisher (`processPendingEvents`)**: Fixed critical bug where pending events were published multiple times due to missing concurrency guard — added `processingPending` mutex flag to prevent concurrent executions

- **Publisher (`processPendingEvents`)**: Fixed infinite reconnection loop and cascading `Channel ended` errors during batch processing — each batch now has its own fresh connection lifecycle

- **Publisher (`processPendingEvents`)**: Fixed `IllegalOperationError: Channel closed` cascading failures — added proactive channel health check before each publish attempt within the batch loop

- **Publisher (`processPendingEvents`)**: Fixed `TypeError: pendingEvents.sort is not a function` when `EventStore.getPendingEvents()` returns non-array iterables — added `Array.isArray` check with `Array.from()` fallback

- **AmqpQueue (`connect`)**: Fixed reconnection not working after a channel/connection closure — `closed` flag is now reset to `false` after a successful `connect()` call

- **AmqpQueue (`disconnect`)**: Fixed potential infinite hang when waiting for in-flight messages on a dead connection — added 10-second timeout to `waitForProcessing`

- **AmqpQueue (channel close handler)**: Channel closure now properly marks the queue as closed via `this.closed = true` in the `channel.on('close')` handler

- `MaxListenersExceededWarning` in property-based tests — resolved by setting `process.setMaxListeners(100)` in `beforeAll`

### Coverage Summary

| Metric     | Coverage |
|------------|----------|
| Statements | 100%     |
| Branches   | 100%     |
| Functions  | 100%     |
| Lines      | 100%     |

---

## [1.2.12] - 2026-03-10

### Fixed

- **Publisher (`processPendingEvents`)**: Fixed critical bug where pending events were published multiple times (e.g., 10 duplicates)
  - **Root cause**: `processPendingEvents()` had no concurrency guard. When the periodic `setInterval` fired while a previous execution was still running, both calls fetched the same PENDING events from the store and published them simultaneously
  - Added a `processingPending` mutex flag that prevents concurrent executions
  - Refactored `processPendingEvents()` into a public guard method + private `_processPendingEventsInternal()` to ensure the flag is always released in a `finally` block

## [1.2.11] - 2026-03-10

### Added

- **AmqpQueue (`forceClose`)**: New method that forcefully cleans up dead or stale connections without waiting for in-flight messages
- **Publisher (`ensureFreshConnection`)**: New private method that force-closes any existing connection and creates a completely new one
- **Publisher (`safeDisconnect`)**: New private method that handles disconnection gracefully, falling back to `forceClose` when the connection is already dead

### Fixed

- **Publisher (`processPendingEvents`)**: Fixed infinite reconnection loop and cascading `Channel ended, no reply will be forthcoming` errors during batch processing
  - Each batch now has its own fresh connection lifecycle — connect at the start, disconnect at the end
  - If a message fails due to a closed channel, the entire batch is aborted immediately; remaining messages stay as PENDING for the next cycle

- **AmqpQueue (`disconnect`)**: Fixed potential infinite hang when `disconnect()` waits for in-flight messages on a dead connection — added a 10-second timeout to `waitForProcessing`

## [1.2.10] - 2026-03-10

### Fixed

- **Publisher (`processPendingEvents`)**: Fixed `IllegalOperationError: Channel closed` cascading failures during batch processing
  - Added proactive channel health check (`queue.closed`) before each publish attempt within the batch loop
  - If reconnection fails, the batch is aborted gracefully — remaining messages stay as PENDING

- **AmqpQueue (`connect`)**: Fixed reconnection not working after a channel/connection closure — `closed` flag is now reset to `false` after a successful `connect()` call

- **AmqpQueue (channel close handler)**: Channel closure now properly marks the queue as closed — added `this.closed = true` to the `channel.on('close')` handler

## [1.2.9] - 2026-03-10

### Fixed

- **Publisher (`processPendingEvents`)**: Fixed `TypeError: pendingEvents.sort is not a function` when `EventStore.getPendingEvents()` returns non-array iterables (e.g., Mongoose cursors, Prisma results)
  - Added defensive `Array.isArray` check with `Array.from()` fallback

## [1.2.8] - 2026-03-10

### Changed

- **Publisher (`processPendingEvents`)**: Refactored to use batched pagination (10 events per batch) instead of loading all pending events into memory at once
  - Prevents `heap allocation failed` / `JavaScript heap out of memory` errors with large backlogs
  - Added optional `limit` parameter to `EventStore.getPendingEvents()` interface to support server-side pagination
  - Improved logging with batch numbers and cumulative success/error counts

### Fixed

- **Pipeline (Jest Hanging)**: Added `globalTeardown` script and `--forceExit` flag to all Jest configurations
- **Node 18 Compatibility**: Added `File` and `Blob` polyfills in test setup for `undici`/`testcontainers`

## [1.2.7] - 2026-03-10

### Added

- **Retry and DLQ Enhancements**: Configurable routing paths for exhausted retry limits; enhanced exponential backoff and connection retry safeguards

### Fixed

- **Tests (Publisher)**: Fixed unhandled promise rejection leaks causing random timeouts and test suite instability
  - Replaced native `unhandledRejection` manipulations with synchronous `.catch` mock injection

### Changed

- **Logging (Publisher)**: Adjusted log levels for reduced noise
  - Demoted idle connection close, "stored for later delivery", and pending events check messages from `info` to `debug`
  - Improved pending events processing log to include `messageId` and success/error summary

## [1.2.5] - 2026-02-25

### Changed

- **Logging**: "Start to processing message" log now only emits when the event type matches a configured processor in `eventsToProcess` — prevents unnecessary log entries for unmatched event types

## [1.2.4] - 2026-02-25

### Changed

- **Logging**: Updated log message criticality levels and reordered log output sequence for better visibility of important events

## [1.2.3] - 2026-02-06

### Changed

- **Logging**: Elevated log level from `info` to `warn` for retry attempts to better highlight transient failures

## [1.2.2] - 2025-11-14

### Fixed

- **DLQ Routing**: Fixed critical issue where messages exceeding max retry attempts were not being routed to the DLQ
  - Implemented manual DLQ publishing when max attempts are exceeded to bypass RabbitMQ DLX limitations
  - Added proper routing key handling for DLQ exchanges
  - Enhanced error headers: `x-error-message`, `x-error-name`, `x-error-stack`, `x-death-count`, `x-death-time`, `x-original-queue`
  - Messages are now ACK'd after being sent to DLQ (preventing infinite retry loops)

### Changed

- **Processor Behavior on Max Attempts**: When a message exceeds `maxAttempts`, the processor now:
  1. Updates event status to `ERROR` in the store
  2. Calls the `onError` hook
  3. Manually publishes the message to the DLQ (if configured)
  4. ACKs the original message (instead of throwing an error)

## [1.2.1] - 2025-11-14

### Added

- **CI/CD Pipeline Unification**: Merged separate test and publish workflows into a single comprehensive CI/CD pipeline
  - Added path filters, expanded Node.js matrix to include Node.js 24, clear job separation
- **Static Badges**: CI/CD status, npm version, Node.js versions, TypeScript, License

### Fixed

- **Timer Cleanup**: Fixed open handles by properly tracking and clearing `idleMonitorTimer` in `ResilientConsumer`
- **Benchmark Tests**: Fixed handler signature mismatch, duplicate detection issue, and queue creation timing

### Changed

- **Jest Configuration**: All configs now include `detectOpenHandles: true` by default
- **Workflow Optimization**: Reduced unnecessary runs through intelligent path filtering

### Removed

- Removed separate `test.yml` and `publish.yml` workflow files (consolidated into `ci-cd.yml`)

## [1.2.0] - 2025-11-14

### Added

- **Complete Test Suite**: Comprehensive automated testing strategy covering all aspects of the library
  - Unit tests, integration tests (Testcontainers), stress tests, and benchmark tests
  - `TestContainersManager`, `RabbitMQHelpers`, `EventStoreMock`, `AMQPLibMock`, `TestDataBuilders`
  - GitHub Actions CI with matrix testing across Node.js 18, 20, and 22
  - Quality gates: coverage ≥ 70%, benchmark regression < 10%, stress test error rate < 1%
  - Quality scripts: `check-coverage.js`, `compare-benchmarks.js`, `generate-benchmark-report.ts`

### Changed

- **Jest Configurations**: Enhanced with proper timeouts, coverage thresholds, and caching
- **Package Scripts**: Added `test:unit`, `test:integration`, `test:stress`, `test:benchmark`, `test:all`, `test:coverage`, `coverage:check`, `benchmark:compare`, `benchmark:report`, `quality:check`

## [1.0.1] - 2025-11-13

### Added

- **`instantPublish`**: Controls whether events are published immediately (`true`, default) or stored for later (`false`)
  - When `false`, a store with `getPendingEvents()` is REQUIRED
  - `pendingEventsCheckIntervalMs` only takes effect when `instantPublish` is `false`

- **Store Connection Management**: `storeConnectionRetries` (default: 3) and `storeConnectionRetryDelayMs` (default: 1000ms) for both Consumer and Publisher

- **Enhanced Logging**: Timestamps via `setLogTimestamps()`, improved formatting and structured output

- **Validation**: Publisher and Consumer now validate configuration on startup with clear error messages

### Changed

- **EventStore Interface**: `getPendingEvents()` is now optional in TypeScript — required only when `instantPublish` is `false`
- **Publisher/Consumer**: Store connection is verified during startup if a store is configured

## [1.0.0] - 2025-11-11

### Added

- **ResilientConsumer**: Retry, DLQ, deduplication, event lifecycle tracking (PENDING → PROCESSING → DONE / RETRY / ERROR / DEAD_LETTER), health monitoring, automatic reconnection, idle detection, SIGTERM/SIGINT handling

- **ResilientEventPublisher**: Pre-publish event storage for guaranteed delivery, status tracking (PENDING / PUBLISHED / ERROR), duplicate detection, pending events processing with chronological ordering, `storeOnly` publish mode

- **Multiple Exchange Bindings**: `consumeQueue.exchanges[]` — bind a single queue to multiple exchanges with independent routing keys

- **Middleware System**: Pluggable pre/post-processing pipeline via `middleware[]` config

- **Event Store Interface**: `saveEvent`, `getEvent`, `updateEventStatus`, `deleteEvent`, `getPendingEvents` — optional; consumer and publisher work without a store

- **AMQP Queue Management**: Connection pooling, exchange/queue assertion, automatic reconnection, all RabbitMQ exchange types (direct, topic, fanout, headers)

- **Lifecycle Hooks**: `onEventStart` (with skip control), `onSuccess`, `onError`

- **TypeScript Support**: Full type definitions, generic event payload typing (`EventMessage<T>`)

- **Logging System**: Configurable levels — `info`, `warn`, `error`, `debug`

---

## Migration Guide

### From 1.x to 2.0.0

No breaking changes to the public API. New optional fields added to config:

```typescript
// Enable metrics (off by default)
const consumer = new ResilientConsumer({ ..., metricsEnabled: true });
const snap = consumer.getMetrics(); // ResilientMQMetrics | undefined

const publisher = new ResilientEventPublisher({ ..., metricsEnabled: true });
const snap = publisher.getMetrics();
```

### EventStore — `getPendingEvents` with limit

Your implementation should respect the optional `limit` parameter:

```typescript
async getPendingEvents(status: EventPublishStatus, limit?: number): Promise<EventMessage[]> {
    const query = EventModel.find({ status }).sort({ createdAt: 1 });
    return limit ? query.limit(limit).exec() : query.exec();
}
```

### Multiple Exchange Bindings

```typescript
consumeQueue: {
    queue: 'my-queue',
    exchanges: [
        { name: 'exchange-1', type: 'topic', routingKey: 'events.*' },
        { name: 'exchange-2', type: 'direct', routingKey: 'notification' }
    ]
}
```

---

## [0.3.3] - 2025-10-22

### Changed

- Publisher now reads the routing key from each event's `routingKey` field when publishing to an exchange. The exchange configuration no longer supplies a per-message routing key.
- `EventMessage` now includes an optional `routingKey?: string` field.

## [0.3.0] - 2025-10-02

### Changed

- Enhanced retry and DLQ handling: refactored retry flow, improved DLQ publishing and routing
- Corrected dead letter routing key handling
- Added richer error details and additional exchange bindings for DLQ handling
- Updated `consumeQueue` configuration to support multiple exchanges

## [0.2.9] - 2025-10-02

### Fixed

- Enhanced retry logic with improved dead-letter handling

## [0.2.8] - 2025-10-02

### Fixed

- Refactored retry and dead-letter queue handling

## Earlier history (2025-05-16 → 2025-06-13)

Initial development, scaffolding, configuration options, retry/DLQ fixes, connection handling improvements, and type reorganization.

---

For more information, visit the [GitHub repository](https://github.com/resilientmq/core).
