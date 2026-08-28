# @resilientmq/core

RabbitMQ consumer and publisher runtime for TypeScript with publisher confirms, broker-owned retries, bounded recovery, inbox leases and a distributed transactional outbox.

## Delivery contract

- Publications resolve only after a positive RabbitMQ publisher confirm. Unroutable mandatory publications reject.
- Consumer failures are rejected into a RabbitMQ dead-letter retry queue. RabbitMQ `x-death`, `x-delivery-count` and `x-acquired-count` headers determine the attempt.
- The final delivery is published and confirmed in the DLQ before the original is acknowledged.
- An atomic inbox store prevents concurrent execution and recovers expired `PROCESSING` leases with fencing tokens.
- An atomic outbox store lets replicas share pending work without publishing every row once per replica.
- AMQP heartbeats and connection/channel lifecycle events trigger reconnection. Shutdown cancels new deliveries, aborts active handlers and drains for a bounded time.

The library provides at-least-once delivery, not exactly-once external side effects. A broker confirm followed by a storage failure can cause a later duplicate. Handlers must make domain writes idempotent or commit the inbox transition and domain mutation in one database transaction.

## Installation

```bash
npm install @resilientmq/core
```

Node.js 18 or newer is required. Public classes and types are exported from the package root.

## Consumer

```ts
import {ResilientConsumer} from '@resilientmq/core';

const consumer = new ResilientConsumer({
  connection: 'amqp://guest:guest@localhost:5672',
  serviceId: 'billing-worker',
  consumeQueue: {
    queue: 'billing.events',
    options: {
      durable: true,
      arguments: {'x-queue-type': 'quorum'}
    },
    exchanges: [
      {name: 'domain.events', type: 'topic', routingKey: 'invoice.*', options: {durable: true}}
    ]
  },
  retryQueue: {
    queue: 'billing.events.retry',
    ttlMs: 5_000,
    maxAttempts: 5,
    options: {durable: true}
  },
  deadLetterQueue: {
    queue: 'billing.events.dead',
    options: {durable: true}
  },
  prefetch: 100,
  processingTimeoutMs: 60_000,
  processingLeaseMs: 90_000,
  store: inboxStore,
  eventsToProcess: [{
    type: 'invoice.created',
    handler: async (event, context) => {
      await createInvoiceIdempotently(event.messageId, event.payload, context.signal);
    }
  }]
});

await consumer.start();

process.once('SIGTERM', async () => {
  await consumer.stop();
});
```

`serviceId` is hashed into a stable identity shared by the replicas of this logical consumer. Each process and delivery also receives an ephemeral identifier through `EventProcessingContext`. Keep `serviceId` stable across deployments that share the same inbox.

`processingLeaseMs` must exceed `processingTimeoutMs`. A timeout aborts `context.signal`; handlers should stop promptly when it is aborted.

## Logging

Logging is configured once through `@resilientmq/core` and applies to every Core
consumer, publisher and connector in the process:

```ts
import {setLogLevel, setLogSampling} from '@resilientmq/core';

setLogLevel('info');

// Optional: emit every informational event in production.
setLogSampling({info: 1});
```

The default level is `none`. At `info`, the consumer reports delivery start,
durable processing success and RabbitMQ retry scheduling. Confirmed dead-letter
outcomes and permanent failures use `error`. Claim acquisition, completed
duplicates, active leases, ignored events, aborts and fencing conflicts are
available only at `debug`.

Consumer lifecycle messages include `message_id`, `event_type` and `attempt`.
Success also includes `duration_ms`; retry logs include `next_attempt` and the
failure; and dead-letter logs identify the target queue. A dead-letter success is
never logged before both RabbitMQ publication confirmation and the terminal inbox
transition succeed.

## Publisher

```ts
import {EventPublishStatus, ResilientEventPublisher} from '@resilientmq/core';

const publisher = new ResilientEventPublisher({
  connection: 'amqp://guest:guest@localhost:5672',
  serviceId: 'checkout-api',
  exchange: {
    name: 'domain.events',
    type: 'topic',
    options: {durable: true}
  },
  maxConcurrentPublishes: 200,
  confirmTimeoutMs: 10_000
});

await publisher.publish({
  messageId: 'event-01J...',
  type: 'invoice.created',
  routingKey: 'invoice.created',
  payload: {invoiceId: 'inv-123'},
  status: EventPublishStatus.PENDING
});

await publisher.disconnect();
```

The configured concurrency is the maximum number of unconfirmed publications on one long-lived confirm channel. Adding connections is not a throughput control; confirm concurrency and broker backpressure are.

### Distributed outbox

```ts
const publisher = new ResilientEventPublisher({
  connection: process.env.AMQP_URL!,
  serviceId: 'checkout-outbox',
  exchange: {name: 'domain.events', type: 'topic', options: {durable: true}},
  store: outboxStore,
  instantPublish: false,
  pendingEventsCheckIntervalMs: 1_000,
  outboxLeaseMs: 30_000,
  outboxRetryDelayMs: 5_000,
  pendingEventsBatchSize: 500,
  pendingEventsMaxPublishesPerSecond: 2_000,
  pendingEventsMaxConcurrentPublishes: 100
});

await publisher.publish(event, {storeOnly: true});
await publisher.processPendingEvents();
```

Deferred mode requires `claimPendingEvents`, `completePublishedEvent` and `releasePublishEvent`. Multiple replicas can run the same pass because each row is atomically leased. When configured, the rate limit is shared across all batches within one process pass; omitting it applies no artificial throttle.

## Store requirements

The compatibility methods remain on the base `EventStore`, while consumer and publisher configuration types require their atomic specializations. Runtime validation also fails fast when untyped JavaScript supplies an incomplete store. Implement each operation as one database transaction or one compare-and-set statement.

| Method | Required invariant |
| --- | --- |
| `claimConsumeEvent` | Insert or acquire an expired inbox lease atomically; return `completed` for terminal rows and `busy` for any live lease. |
| `transitionConsumeEvent` | Update only when service, instance and fencing token still own the lease. |
| `claimPendingEvents` | Select pending/expired rows with skip-locked or equivalent semantics and assign fresh fencing tokens atomically. |
| `claimPublishEvent` | Apply the same exclusive claim to one known event. |
| `completePublishedEvent` | Mark `PUBLISHED` only for the current fencing token. |
| `releasePublishEvent` | Return the current claim to `PENDING` with `nextAttemptAt`. |

See [docs/resilience-model.md](docs/resilience-model.md) for transitions and failure behavior.

## Metrics

`metricsSink` receives compact facts after runtime events such as confirmed publication, retry scheduling, dead-lettering and reconnects. Sink failures never change ACK or publication behavior.

For a remote or database-backed sink, wrap it with `BufferedMetricsSink` so I/O is performed outside the delivery/confirm path. Set `metricsEnabled: true` only when an in-process aggregate snapshot from `getMetrics()` is needed.

## Performance

`prefetch` limits unacknowledged deliveries; it does not create parallelism by itself. Throughput rises with prefetch only when several asynchronous handlers can overlap. A synchronous CPU-bound handler remains limited by the Node.js event loop.

Publishing throughput is primarily controlled by `maxConcurrentPublishes`, confirm latency, message size, routing and broker capacity. Mandatory routing and confirms are intentional correctness costs.

Run the real-broker suites with:

```bash
npm run test:integration
npm run test:stress
npm run test:benchmark
```

## Migrating from v2

- `maxConnections`, publisher pools, adaptive pending concurrency and idle connection options were removed.
- `heartbeatIntervalMs`, `maxUptimeMs`, `exitIfIdle`, `idleCheckIntervalMs`, `maxIdleChecks` and the cleanup consumer option were removed.
- Missing queues or unroutable exchange publications now reject instead of appearing successful.
- Retries no longer use application-generated `x-retry-count` or fabricated `x-death` headers.
- Deferred publishing requires fenced outbox claim methods; legacy `getPendingEvents` is not safe for replicas.
- Any configured store now requires atomic inbox or outbox methods instead of silently degrading to replica-unsafe compatibility operations.
- Handlers receive an `EventProcessingContext` with an `AbortSignal` and fencing identity.

## License

MIT
