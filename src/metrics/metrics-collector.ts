/** Event names emitted by the resilience runtime. */
export type ResilienceMetricEventName =
    | 'broker.connected'
    | 'broker.disconnected'
    | 'delivery.received'
    | 'delivery.duplicate'
    | 'delivery.lease_busy'
    | 'consume.completed'
    | 'consume.retry_scheduled'
    | 'consume.failed'
    | 'consume.dead_lettered'
    | 'publish.confirmed'
    | 'publish.failed'
    | 'publish.returned'
    | 'outbox.claimed'
    | 'outbox.released';

/** One immutable fact emitted for an event or transport transition. */
export interface ResilienceMetricEvent {
    /** Fact represented by the event. */
    name: ResilienceMetricEventName;

    /** Unix timestamp in milliseconds. */
    timestamp: number;

    /** Message identity when the fact belongs to a message. */
    messageId?: string;

    /** Stable service hash. */
    serviceId?: string;

    /** Ephemeral process identity. */
    instanceId?: string;

    /** RabbitMQ delivery attempt. */
    attempt?: number;

    /** Operation duration in milliseconds. */
    durationMs?: number;

    /** Error name without a stack or payload. */
    errorName?: string;
}

/** Receives event-oriented metrics without participating in message correctness. */
export interface MetricsSink {
    /** Accepts one metric event. */
    emit(event: ResilienceMetricEvent): void | Promise<void>;
}

/** Snapshot of aggregated in-process metrics. */
export interface ResilientMQMetrics {
    /** Total deliveries received. */
    messagesReceived: number;

    /** Deliveries completed successfully. */
    messagesProcessed: number;

    /** Deliveries scheduled through retry routing. */
    messagesRetried: number;

    /** Deliveries that failed permanently. */
    messagesFailed: number;

    /** Deliveries confirmed in the dead-letter destination. */
    messagesSentToDLQ: number;

    /** Publications confirmed by RabbitMQ. */
    messagesPublished: number;

    /** Total processing or publication errors. */
    processingErrors: number;

    /** Average completed operation duration. */
    avgProcessingTimeMs: number;

    /** Time of the latest metric event. */
    lastActivityAt?: Date;
}

type CounterKey = keyof Omit<ResilientMQMetrics, 'avgProcessingTimeMs' | 'lastActivityAt'>;
type CounterState = Omit<ResilientMQMetrics, 'avgProcessingTimeMs' | 'lastActivityAt'>;

function createZeroCounters(): CounterState {
    return {
        messagesReceived: 0,
        messagesProcessed: 0,
        messagesRetried: 0,
        messagesFailed: 0,
        messagesSentToDLQ: 0,
        messagesPublished: 0,
        processingErrors: 0
    };
}

/** Aggregates metric events in memory for inexpensive snapshots. */
export class MetricsCollector implements MetricsSink {
    private counters: CounterState = createZeroCounters();
    private totalProcessingTimeMs = 0;
    private processingTimeSamples = 0;
    private lastActivityAt?: Date;

    /** Records one event-oriented metric. */
    emit(event: ResilienceMetricEvent): void {
        const counter = this.counterFor(event.name);
        if (counter) this.counters[counter]++;
        if (event.durationMs !== undefined) this.recordProcessingTime(event.durationMs);
        else this.lastActivityAt = new Date(event.timestamp);
    }

    /** Increments a legacy counter. */
    increment(key: CounterKey): void {
        this.counters[key]++;
        this.lastActivityAt = new Date();
    }

    /** Adds one operation duration sample. */
    recordProcessingTime(ms: number): void {
        this.totalProcessingTimeMs += ms;
        this.processingTimeSamples++;
        this.lastActivityAt = new Date();
    }

    /** Returns an immutable snapshot. */
    getSnapshot(): ResilientMQMetrics {
        return {
            ...this.counters,
            avgProcessingTimeMs: this.processingTimeSamples > 0
                ? this.totalProcessingTimeMs / this.processingTimeSamples
                : 0,
            lastActivityAt: this.lastActivityAt
        };
    }

    /** Resets every aggregate. */
    reset(): void {
        this.counters = createZeroCounters();
        this.totalProcessingTimeMs = 0;
        this.processingTimeSamples = 0;
        this.lastActivityAt = undefined;
    }

    private counterFor(name: ResilienceMetricEventName): CounterKey | undefined {
        switch (name) {
            case 'delivery.received': return 'messagesReceived';
            case 'consume.completed': return 'messagesProcessed';
            case 'consume.retry_scheduled': return 'messagesRetried';
            case 'consume.failed': return 'messagesFailed';
            case 'consume.dead_lettered': return 'messagesSentToDLQ';
            case 'publish.confirmed': return 'messagesPublished';
            case 'publish.failed': return 'processingErrors';
            default: return undefined;
        }
    }
}

/** Buffers metrics so a storage-backed sink never delays ACKs or confirms. */
export class BufferedMetricsSink implements MetricsSink {
    private readonly queue: ResilienceMetricEvent[] = [];
    private draining = false;

    constructor(
        private readonly sink: MetricsSink,
        private readonly capacity = 10000,
        private readonly batchSize = 100
    ) {
        if (!Number.isInteger(capacity) || capacity <= 0) {
            throw new Error('Metrics buffer capacity must be a positive integer');
        }
        if (!Number.isInteger(batchSize) || batchSize <= 0) {
            throw new Error('Metrics batch size must be a positive integer');
        }
    }

    /** Enqueues a metric and schedules background delivery. */
    emit(event: ResilienceMetricEvent): void {
        if (this.queue.length >= this.capacity) this.queue.shift();
        this.queue.push(event);
        this.scheduleDrain();
    }

    /** Waits until every currently buffered metric has been offered to the sink. */
    async flush(): Promise<void> {
        while (this.draining || this.queue.length > 0) {
            if (!this.draining) await this.drain();
            else await new Promise(resolve => setTimeout(resolve, 1));
        }
    }

    private scheduleDrain(): void {
        if (this.draining) return;
        this.draining = true;
        setImmediate(() => {
            this.drain().catch(() => undefined);
        });
    }

    private async drain(): Promise<void> {
        this.draining = true;
        try {
            while (this.queue.length > 0) {
                const batch = this.queue.splice(0, this.batchSize);
                for (const event of batch) {
                    try {
                        await this.sink.emit(event);
                    } catch {}
                }
            }
        } finally {
            this.draining = false;
            if (this.queue.length > 0) this.scheduleDrain();
        }
    }
}
