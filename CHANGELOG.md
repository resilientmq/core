# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

