# @resilientmq/core

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
- [🧪 Tests](#-tests)
- [Docs](#docs)
- [LICENSE](#license)

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

| Property | Type | Required | Description | Subtype Fields |
|----------|------|----------|-------------|----------------|
| `connection` | `string \| Options.Connect` | ✅ | RabbitMQ URI or connection config | – |
| `consumeQueue.queue` | `string` | ✅ | Queue name to consume | – |
| `consumeQueue.options` | `AssertQueueOptions` | ✅ | Queue assertion options | durable, arguments |
| `consumeQueue.exchange` | `ExchangeConfig` | ❌ | Bind queue to this exchange | name, type, routingKey, options |
| `retryQueue.queue` | `string` | ❌ | Retry queue for failed messages | – |
| `retryQueue.options` | `AssertQueueOptions` | ❌ | Queue options | durable, arguments |
| `retryQueue.exchange` | `ExchangeConfig` | ❌ | Exchange for retry routing | name, type, routingKey, options |
| `retryQueue.ttlMs` | `number` | ❌ | Delay before retrying | – |
| `retryQueue.maxAttempts` | `number` | ❌ | Max retries before DLQ (default 5) | – |
| `deadLetterQueue.queue` | `string` | ❌ | Final destination after retries | – |
| `deadLetterQueue.options` | `AssertQueueOptions` | ❌ | DLQ queue options | durable |
| `deadLetterQueue.exchange` | `ExchangeConfig` | ❌ | DLQ exchange | name, type, routingKey, options |
| `eventsToProcess` | `EventProcessConfig[]` | ✅ | List of handled event types | type, handler |
| `store` | `EventStore` | ✅ | Persistent layer for events | saveEvent, getEvent, updateEventStatus, deleteEvent |
| `middleware` | `Middleware[]` | ❌ | Hooks to wrap event execution | (event, next) => Promise |
| `maxUptimeMs` | `number` | ❌ | Restart consumer after X ms | – |
| `exitIfIdle` | `boolean` | ❌ | Exit process if idle | – |
| `idleCheckIntervalMs` | `number` | ❌ | Time between idle checks | – |
| `maxIdleChecks` | `number` | ❌ | How many checks until exit | – |

---

## 🔧 Config: `ResilientPublisherConfig`

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `connection` | `string \| Options.Connect` | ✅ | RabbitMQ URI or config |
| `queue` | `string` | ❌ | Target queue (direct publish) |
| `exchange` | `ExchangeConfig` | ❌ | Exchange for fanout/direct |
| `store` | `EventStore` | ✅ | Event metadata persistence |

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
    exchange: { name: 'user.events', type: 'fanout', options: { durable: true } }
  },
  eventsToProcess: [
    { type: 'user.created', handler: async (payload) => console.log(payload) }
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
  store: myStore,
  exchange: {
    name: 'user.events',
    type: 'fanout',
    options: { durable: true }
  }
});

await publisher.publish({
  id: 'evt-1',
  messageId: 'msg-1',
  type: 'user.created',
  payload: { name: 'Alice' },
  status: 'PENDING_PUBLICATION'
});
```

---

## 🧪 Tests

- ✅ Unit tests with Jest
- ✅ Integration-ready structure
- ✅ 100% coverage possible with mocks

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