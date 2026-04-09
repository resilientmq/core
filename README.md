# 🆕 Ignoring events with controlled errors

You can throw the `IgnoredEventError` from an event handler to indicate that the event should be ignored and marked as successfully processed, even if the normal logic was not executed. This is useful for cases where certain events should not be retried or sent to the DLQ.

```ts
import { IgnoredEventError } from '@resilientmq/core/dist/resilience';

const consumer = new ResilientConsumer({
  // ...configuration
  eventsToProcess: [
    {
      type: 'user.created',
      handler: async (event) => {
        if (event.payload.ignore) {
          throw new IgnoredEventError('Event ignored by business rule');
        }
        // normal logic...
      }
    }
  ]
});
```

When this error is thrown, the event is marked as `DONE` and will not be retried or sent to the DLQ.
# @resilientmq/core

[![CI/CD Pipeline](https://github.com/resilientmq/core/actions/workflows/ci-cd.yml/badge.svg?branch=master)](https://github.com/resilientmq/core/actions/workflows/ci-cd.yml)
[![npm version](https://badge.fury.io/js/@resilientmq%2Fcore.svg)](https://www.npmjs.com/package/@resilientmq/core)
[![Node.js Version](https://img.shields.io/badge/node-18%20%7C%2020%20%7C%2022%20%7C%2024%20%7C%2025-brightgreen.svg)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-blue.svg)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Core logic for the resilient message queue system built on top of RabbitMQ, providing middleware support, retry logic, dead-letter handling, and persistent event lifecycle management.

## Table of Contents

- [📦 Installation](#-installation)
- [📚 Purpose](#-purpose)
- [🧩 Main Concepts](#-main-concepts)
- [🔧 Config: ResilientConsumerConfig](#-config-resilientconsumerconfig)
- [🔧 Config: ResilientPublisherConfig](#-config-resilientpublisherconfig)
- [🧩 Custom Event Storage Format](#-custom-event-storage-format)
  - [🔄 Example: Custom Storage Serializer](#-example-custom-storage-serializer)
- [🚀 Example: Consumer](#-example-consumer)
- [🚀 Example: Publisher](#-example-publisher)
- [📊 Metrics](#-metrics)
- [🧪 Testing](#-testing)
- [👥 Contributors](#-contributors)
- [📄 License](#-license)

## 📦 Installation

```bash
npm install @resilientmq/core
```

Make sure to also install the core types package:

```bash
npm install @resilientmq/types__core
```

## 📚 Purpose

This package contains the **runtime logic** for publishing and consuming resilient events. It includes:

- A pluggable consumer with retry + DLQ logic
- Publisher with persist-before-send safety
- Middleware pipeline
- Custom logger
- Full TypeScript support

---

## 🧩 Main Concepts

| Feature | Description |
|--------|-------------|
| `publish(event)` | Publishes a message safely to a queue or exchange |
| `consume(handler)` | Starts a consumer to process incoming messages |
| `ResilientConsumer` | Handles connection, retry, DLQ, and auto-reconnect |
| `ResilientEventPublisher` | Publishes events with status persistence |
| `log(level, message)` | Unified logging mechanism |
| `Middleware` | Custom logic pipeline on message consumption |

---

## 🔧 Config: `ResilientConsumerConfig`

| Property                   | Type                        | Required | Description                        | Subtype Fields |
|----------------------------|-----------------------------|----------|------------------------------------|----------------|
| `connection`               | `string \| Options.Connect` | ✅ | RabbitMQ URI or connection config  | – |
| `consumeQueue.queue`       | `string`                    | ✅ | Queue name to consume              | – |
| `consumeQueue.options`     | `AssertQueueOptions`        | ✅ | Queue assertion options            | durable, arguments |
| `consumeQueue.exchanges`   | `ExchangeConfig[]`          | ❌ | exchanges to bind queue to         | name, type, routingKey, options |
| `retryQueue.queue`         | `string`                    | ❌ | Retry queue for failed messages    | – |
| `retryQueue.options`       | `AssertQueueOptions`        | ❌ | Queue options                      | durable, arguments |
| `retryQueue.exchange`      | `ExchangeConfig`            | ❌ | Exchange for retry routing         | name, type, routingKey, options |
| `retryQueue.ttlMs`         | `number`                    | ❌ | Delay before retrying              | – |
| `retryQueue.maxAttempts`   | `number`                    | ❌ | Max retries before DLQ (default 5) | – |
| `deadLetterQueue.queue`    | `string`                    | ❌ | Final destination after retries    | – |
| `deadLetterQueue.options`  | `AssertQueueOptions`        | ❌ | DLQ queue options                  | durable |
| `deadLetterQueue.exchange` | `ExchangeConfig`            | ❌ | DLQ exchange                       | name, type, routingKey, options |
| `eventsToProcess`          | `EventProcessConfig[]`      | ✅ | List of handled event types        | type, handler |
| `store`                    | `EventStore`                | ❌ | Persistent layer for events        | saveEvent, getEvent, updateEventStatus, deleteEvent, getPendingEvents (optional), batchUpdateEventStatus (optional) |
| `storeConnectionRetries`   | `number`                    | ❌ | Max retry attempts for store connection (default: 3) | – |
| `storeConnectionRetryDelayMs` | `number`                 | ❌ | Delay between store retry attempts in ms (default: 1000) | – |
| `cleanupConsumerPrefetch`   | `number`                    | ❌ | Prefetch for secondary cleanup connection used when `ignoreUnknownEvents` is true (default: 500, set `0` to disable) | – |
| `middleware`               | `Middleware[]`              | ❌ | Hooks to wrap event execution      | (event, next) => Promise |
| `maxUptimeMs`              | `number`                    | ❌ | Restart consumer after X ms        | – |
| `exitIfIdle`               | `boolean`                   | ❌ | Exit process if idle               | – |
| `idleCheckIntervalMs`      | `number`                    | ❌ | Time between idle checks           | – |
| `maxIdleChecks`            | `number`                    | ❌ | How many checks until exit         | – |

---

## 🔧 Config: `ResilientPublisherConfig`

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `connection` | `string \| Options.Connect` | ✅ | RabbitMQ URI or config |
| `queue` | `string` | ❌ | Target queue (direct publish) |
| `exchange` | `ExchangeConfig` | ❌ | Exchange for fanout/direct |
| `store` | `EventStore` | ❌* | Event metadata persistence (optional unless `instantPublish` is false) |
| `instantPublish` | `boolean` | ❌ | If true (default), publishes immediately. If false, stores for later delivery |
| `pendingEventsCheckIntervalMs` | `number` | ❌ | Interval to check and send pending events (ms). Only effective when `instantPublish` is false |
| `maxConcurrentPublishes` | `number` | ❌ | Global backpressure limit for concurrent publish operations (default: `100`) |
| `maxConnections` | `number` | ❌ | Number of RabbitMQ connections in the pool for load distribution (default: `1`) |
| `pendingEventsBatchSize` | `number` | ❌ | Default number of pending events fetched per batch when calling `processPendingEvents()` |
| `pendingEventsMaxPublishesPerSecond` | `number` | ❌ | Default max number of pending events dispatched per second during `processPendingEvents()` |
| `pendingEventsMaxConcurrentPublishes` | `number` | ❌ | Default max number of pending events published in parallel during `processPendingEvents()` |
| `storeConnectionRetries` | `number` | ❌ | Max retry attempts for store connection (default: 3) |
| `storeConnectionRetryDelayMs` | `number` | ❌ | Delay between store retry attempts in ms (default: 1000) |
| `metricsEnabled` | `boolean` | ❌ | Enable runtime metrics collection for the publisher |

**Note**: When `instantPublish` is set to `false`, a `store` with `getPendingEvents()` method is **REQUIRED**.

---
## 🧩 Custom Event Storage Format

You can fully control how events are stored and retrieved by providing a `serializer` in your `EventStore` implementation.

This allows you to decouple the in-memory event format from the database structure — useful for legacy systems or when mapping to existing schemas.

### 🔄 Example: Custom Storage Serializer

```ts
const store: EventStore = {
  serializer: {
    toStorageFormat(event) {
      return {
        _id: event.id,
        body: event.payload,
        customStatus: event.status
      };
    },
    fromStorageFormat(doc) {
      return {
        id: doc._id,
        messageId: doc._id,
        payload: doc.body,
        status: doc.customStatus,
        type: 'custom.type'
      };
    }
  },

  async saveEvent(event) {
    const doc = this.serializer.toStorageFormat(event);
    await db.insert(doc);
  },

  async getEvent(id) {
    const doc = await db.findById(id);
    return doc ? this.serializer.fromStorageFormat(doc) : null;
  },

  async updateEventStatus(id, status) {
    await db.update(id, { customStatus: status });
  },

  async deleteEvent(id) {
    await db.delete(id);
  },

  // Required for processPendingEvents() — supports optional `limit` for batched retrieval
  async getPendingEvents(status, limit?) {
    const query = db.find({ customStatus: status }).sort({ createdAt: 1 });
    return limit ? query.limit(limit) : query;
  }
};
```

---

## 🚀 Example: Consumer

```ts
import { ResilientConsumer } from '@resilientmq/core';
import mongoose from 'mongoose';

const Event = mongoose.model('Event', new mongoose.Schema({ id: String }));
const store = {
  saveEvent: async (e) => Event.create(e),
  getEvent: async (id) => Event.findOne({ messageId: id }),
  updateEventStatus: async (id, status) => Event.updateOne({ messageId: id }, { status }),
  deleteEvent: async (id) => Event.deleteOne({ messageId: id })
};

const consumer = new ResilientConsumer({
  connection: 'amqp://localhost',
  consumeQueue: {
    queue: 'user.queue',
    options: { durable: true },
    exchanges: [
      { name: 'orders.events', type: 'topic', routingKey: 'order.*', options: { durable: true } },
      { name: 'notifications.events', type: 'direct', routingKey: 'notification', options: { durable: true } }
    ]
  },
  eventsToProcess: [
    { type: 'user.created', handler: async (payload) => console.log('User created:', payload) },
    { type: 'order.placed', handler: async (payload) => console.log('Order placed:', payload) },
    { type: 'notification.sent', handler: async (payload) => console.log('Notification sent:', payload) }
  ],
  store
});

await consumer.start();
```

---

## 🚀 Example: Publisher

```ts
import { ResilientEventPublisher } from '@resilientmq/core';

const publisher = new ResilientEventPublisher({
  connection: 'amqp://localhost',
  exchange: {
    name: 'user.events',
    type: 'fanout',
    options: { durable: true }
  },
  maxConnections: 3  // Use 3 connections for load distribution (optional, default: 1)
});

// IMPORTANT: routingKey is now taken from each event's `routingKey` field when publishing to an exchange.
// If the event does not include `routingKey`, the publisher will send the message with no routing key.
// The exchange configuration no longer provides the routing key for per-message routing.

await publisher.publish({
  id: 'evt-1',
  messageId: 'msg-1',
  type: 'user.created',
  payload: { name: 'Alice' },
  status: 'PENDING_PUBLICATION',
  // Optional per-message routing key;
  routingKey: 'user.created'
});
```

### Publisher Without Store

```ts
import { ResilientEventPublisher } from '@resilientmq/core';

const publisher = new ResilientEventPublisher({
  connection: 'amqp://localhost',
  exchange: {
    name: 'user.events',
    type: 'fanout',
    options: { durable: true }
  },
  maxConnections: 5  // Optional: distribute load across 5 connections
});

await publisher.publish({
  id: 'evt-2',
  messageId: 'msg-2',
  type: 'user.updated',
  payload: { name: 'Bob' },
  status: 'PENDING_PUBLICATION'
});
```

### Publisher with Pending Events Processing

```ts
import { ResilientEventPublisher } from '@resilientmq/core';

const publisher = new ResilientEventPublisher({
  connection: 'amqp://localhost',
  exchange: {
    name: 'user.events',
    type: 'fanout',
    options: { durable: true }
  },
  store: myEventStore,
  // Check for pending events every 30 seconds
  pendingEventsCheckIntervalMs: 30000,
  // Use multiple connections for better throughput
  maxConnections: 3
});

// Store event for later delivery (e.g., when offline)
await publisher.publish({
  id: 'evt-3',
  messageId: 'msg-3',
  type: 'user.deleted',
  payload: { id: '123' },
  status: 'PENDING'
}, { storeOnly: true });

// The event will be automatically sent every 30 seconds if there are pending events

// Or manually process pending events
await publisher.processPendingEvents();

// Stop periodic checks when shutting down
publisher.stopPendingEventsCheck();
```

**Key Features:**
- **`storeOnly: true`**: Stores the event without sending it immediately (useful for offline scenarios)
- **`pendingEventsCheckIntervalMs`**: Configurable interval to automatically check and send pending events
- **`processPendingEvents()`**: Manually trigger processing of pending events
- **`stopPendingEventsCheck()`**: Stop the periodic check for graceful shutdown
- **`maxConnections`**: Distribute load across multiple RabbitMQ connections (round-robin)
- Events are automatically sorted and sent in chronological order (oldest first)
- Only connects to RabbitMQ when there are actually pending events to process

### ⚡ Pending Events Processing with Rate Limiting (v2.1.5+)

`processPendingEvents()` supports configurable rate limiting to control throughput and prevent overwhelming your RabbitMQ broker or downstream systems.

**Configuration options:**

```ts
await publisher.processPendingEvents({
  batchSize: 1000,                    // Number of events to retrieve per batch (default: 100)
  maxPublishesPerSecond: 500,         // Maximum events published per second (default: same as batchSize)
  maxConcurrentPublishes: 10          // Maximum concurrent publish operations (default: min(10, maxPublishesPerSecond))
});
```

**How it works:**
1. Retrieves `batchSize` pending events from the store
2. Publishes events using a token bucket algorithm to respect `maxPublishesPerSecond`
3. Maintains up to `maxConcurrentPublishes` parallel operations
4. Updates all statuses in a single batch operation
5. Repeats until no more pending events

**Token Bucket Algorithm:**
- Provides smooth, continuous rate limiting (not fixed 1-second windows)
- Allows burst capacity while maintaining average rate
- Refills tokens continuously based on elapsed time

**Performance characteristics:**
- Can achieve 500-1000 msg/s with proper configuration
- Prevents broker overload with controlled throughput
- Batch status updates reduce database overhead by 90%

**Important:** Events are processed in the order returned by your store. If you need chronological ordering, implement sorting in your `getPendingEvents()` method:

```ts
async getPendingEvents(status: EventPublishStatus, limit?: number): Promise<EventMessage[]> {
  const query = EventModel.find({ status }).sort({ createdAt: 1 }); // Sort by timestamp
  return limit ? query.limit(limit).exec() : query.exec();
}
```

#### Example: Implementing `getPendingEvents` with limit

```ts
// MongoDB / Mongoose example
async getPendingEvents(status: EventPublishStatus, limit?: number): Promise<EventMessage[]> {
  const query = EventModel.find({ status }).sort({ createdAt: 1 });
  if (limit) {
    query.limit(limit);
  }
  return query.exec();
}

// Prisma example
async getPendingEvents(status: EventPublishStatus, limit?: number): Promise<EventMessage[]> {
  return prisma.event.findMany({
    where: { status },
    orderBy: { createdAt: 'asc' },
    ...(limit ? { take: limit } : {})
  });
}
```

#### 🚀 Critical: Implement Batch Status Updates (v2.1.2+)

For maximum performance, you **MUST** implement the optional `batchUpdateEventStatus()` method in your `EventStore`.

**Benefits:**
- **90% reduction in database calls**: From 1000 individual updates/s to ~10 batched calls/s
- **10-100x throughput improvement**: Process at maximum speed without database bottleneck
- **Backward compatible**: Falls back to individual updates if not implemented

```ts
// MongoDB / Mongoose example
async batchUpdateEventStatus(
  updates: Array<{ event: EventMessage; status: EventPublishStatus }>
): Promise<void> {
  const bulkOps = updates.map(({ event, status }) => ({
    updateOne: {
      filter: { messageId: event.messageId },
      update: { $set: { status } }
    }
  }));
  
  await EventModel.bulkWrite(bulkOps);
}

// Prisma example
async batchUpdateEventStatus(
  updates: Array<{ event: EventMessage; status: EventPublishStatus }>
): Promise<void> {
  await prisma.$transaction(
    updates.map(({ event, status }) =>
      prisma.event.update({
        where: { messageId: event.messageId },
        data: { status }
      })
    )
  );
}

// SQL example (using Knex)
async batchUpdateEventStatus(
  updates: Array<{ event: EventMessage; status: EventPublishStatus }>
): Promise<void> {
  const trx = await db.transaction();
  try {
    for (const { event, status } of updates) {
      await trx('events')
        .where({ message_id: event.messageId })
        .update({ status });
    }
    await trx.commit();
  } catch (error) {
    await trx.rollback();
    throw error;
  }
}
```

**How it works:**
- The publisher batches status updates every 100ms during `processPendingEvents()`
- If `batchUpdateEventStatus()` is implemented, it's used automatically
- If not implemented or if it fails, falls back to individual `updateEventStatus()` calls
- No code changes needed in your publisher - just implement the method in your store

---

## 📊 Metrics

`ResilientConsumer` and `ResilientEventPublisher` support optional real-time metrics collection.
Enable it with `metricsEnabled: true` in the config, then call `getMetrics()` at any time to get
a snapshot.

```ts
import { ResilientConsumer, ResilientEventPublisher } from '@resilientmq/core';

// Consumer with metrics
const consumer = new ResilientConsumer({
  connection: 'amqp://localhost',
  consumeQueue: { queue: 'my.queue' },
  eventsToProcess: [{ type: 'order.created', handler: async (e) => { /* ... */ } }],
  metricsEnabled: true,   // <-- enable metrics
});

await consumer.start();

// Inspect metrics at any time
const snap = consumer.getMetrics();
console.log(snap);
// {
//   messagesReceived: 142,
//   messagesProcessed: 140,
//   messagesRetried: 3,
//   messagesFailed: 2,
//   messagesSentToDLQ: 2,
//   messagesPublished: 0,
//   processingErrors: 2,
//   avgProcessingTimeMs: 18.4,
//   lastActivityAt: 2026-03-16T10:23:45.000Z
// }
```

```ts
// Publisher with metrics
const publisher = new ResilientEventPublisher({
  connection: 'amqp://localhost',
  queue: 'my.queue',
  metricsEnabled: true,   // <-- enable metrics
});

await publisher.publish({ messageId: 'id-1', type: 'order.created', payload: {} });

const snap = publisher.getMetrics();
console.log(snap?.messagesPublished); // 1
```

You can also use `MetricsCollector` standalone for custom instrumentation:

```ts
import { MetricsCollector } from '@resilientmq/core';

const metrics = new MetricsCollector();
metrics.increment('messagesReceived');
metrics.recordProcessingTime(42);
const snapshot = metrics.getSnapshot();
metrics.reset(); // reset all counters
```

### Available Metrics

| Field | Description |
|-------|-------------|
| `messagesReceived` | Total messages received by the consumer |
| `messagesProcessed` | Messages successfully processed |
| `messagesRetried` | Messages retried at least once |
| `messagesFailed` | Messages that failed permanently |
| `messagesSentToDLQ` | Messages sent to the Dead Letter Queue |
| `messagesPublished` | Messages published by the publisher |
| `processingErrors` | Total processing errors encountered |
| `avgProcessingTimeMs` | Average processing time in milliseconds |
| `lastActivityAt` | Timestamp of the last recorded activity |

> `getMetrics()` returns `undefined` when `metricsEnabled` is not set or is `false`.

---

## 🧪 Testing

@resilientmq/core includes a comprehensive automated testing strategy to ensure reliability, performance, and quality.

### Test Suite Overview

| Test Type | Purpose | Execution Time | Coverage |
|-----------|---------|----------------|----------|
| **Unit Tests** | Fast, isolated component testing with mocks | < 30s | 70%+ code coverage |
| **Integration Tests** | End-to-end testing with real RabbitMQ | < 5min | Full integration scenarios |
| **Stress Tests** | High-volume and high-speed load testing | < 10min | Resilience validation |
| **Benchmarks** | Performance measurement and regression detection | < 15min | Throughput & latency metrics |

### Running Tests

```bash
# Run all tests
npm test

# Run specific test suites
npm run test:unit              # Unit tests only
npm run test:integration       # Integration tests (requires Docker)
npm run test:stress           # Stress tests (requires Docker)
npm run test:benchmark        # Performance benchmarks (requires Docker)

# Run with coverage
npm run test:coverage         # Generate coverage report
npm run coverage:check        # Validate coverage thresholds

# Quality checks
npm run benchmark:compare     # Check for performance regressions
npm run quality:check         # Run all quality gates
```

### Test Infrastructure

- **Testcontainers**: Automatic RabbitMQ container management for integration tests
- **Jest**: Test framework with TypeScript support
- **Mocks & Helpers**: Comprehensive test utilities for all components
- **Metrics Collection**: Automated performance and resource usage tracking

### CI/CD Integration

All tests run automatically on:
- Every push to main/master/develop branches
- Every pull request
- Matrix testing across Node.js 18, 20, 22, 24 and 25

**Quality Gates:**
- ✅ Minimum 70% code coverage
- ✅ All tests must pass
- ✅ Performance regression < 10%
- ✅ Error rate under load < 1%

For detailed testing documentation, see [test/README.md](test/README.md).

---

## 👥 Contributors

<!-- ALL-CONTRIBUTORS-LIST:START -->
<table>
  <tbody>
    <tr>
      <td align="center" valign="top" width="14.28%">
        <a href="https://github.com/hector-ae21">
          <img src="https://avatars.githubusercontent.com/u/87265357?v=4" width="100px;" alt="Hector L. Arrechea"/>
          <br /><sub><b>Hector L. Arrechea</b></sub>
        </a>
        <br /><a title="Code">💻</a> <a title="Documentation">📖</a> <a title="Infra">🚇</a> <a title="Tests">⚠️</a>
      </td>
    </tr>
  </tbody>
</table>
<!-- ALL-CONTRIBUTORS-LIST:END -->

---

## 📄 License

[MIT](LICENSE)



