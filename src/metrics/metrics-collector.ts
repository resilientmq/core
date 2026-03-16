/**
 * Snapshot of all tracked metrics at a point in time.
 */
export interface ResilientMQMetrics {
    /** Total messages received by the consumer. */
    messagesReceived: number;
    /** Messages successfully processed. */
    messagesProcessed: number;
    /** Messages that were retried at least once. */
    messagesRetried: number;
    /** Messages that failed permanently (sent to DLQ or discarded). */
    messagesFailed: number;
    /** Messages sent to the Dead Letter Queue. */
    messagesSentToDLQ: number;
    /** Messages published by the publisher. */
    messagesPublished: number;
    /** Total processing errors encountered. */
    processingErrors: number;
    /** Average processing time in milliseconds (0 if no data). */
    avgProcessingTimeMs: number;
    /** Timestamp of the last recorded activity. */
    lastActivityAt?: Date;
}

/**
 * Collects and exposes runtime metrics for consumers and publishers.
 *
 * Usage:
 * ```ts
 * const metrics = new MetricsCollector();
 * metrics.increment('messagesReceived');
 * metrics.recordProcessingTime(42);
 * const snapshot = metrics.getSnapshot();
 * ```
 */
export class MetricsCollector {
    private counters: Omit<ResilientMQMetrics, 'avgProcessingTimeMs' | 'lastActivityAt'> = {
        messagesReceived: 0,
        messagesProcessed: 0,
        messagesRetried: 0,
        messagesFailed: 0,
        messagesSentToDLQ: 0,
        messagesPublished: 0,
        processingErrors: 0,
    };

    private totalProcessingTimeMs = 0;
    private processingTimeSamples = 0;
    private lastActivityAt?: Date;

    /**
     * Increments a counter metric by 1 and updates lastActivityAt.
     */
    increment(key: keyof Omit<ResilientMQMetrics, 'avgProcessingTimeMs' | 'lastActivityAt'>): void {
        this.counters[key]++;
        this.lastActivityAt = new Date();
    }

    /**
     * Records a processing time sample (in milliseconds) and updates lastActivityAt.
     */
    recordProcessingTime(ms: number): void {
        this.totalProcessingTimeMs += ms;
        this.processingTimeSamples++;
        this.lastActivityAt = new Date();
    }

    /**
     * Returns an immutable snapshot of the current metrics.
     */
    getSnapshot(): ResilientMQMetrics {
        const avgProcessingTimeMs =
            this.processingTimeSamples > 0
                ? this.totalProcessingTimeMs / this.processingTimeSamples
                : 0;

        return {
            ...this.counters,
            avgProcessingTimeMs,
            lastActivityAt: this.lastActivityAt,
        };
    }

    /**
     * Resets all counters and timing data to zero.
     */
    reset(): void {
        this.counters = {
            messagesReceived: 0,
            messagesProcessed: 0,
            messagesRetried: 0,
            messagesFailed: 0,
            messagesSentToDLQ: 0,
            messagesPublished: 0,
            processingErrors: 0,
        };
        this.totalProcessingTimeMs = 0;
        this.processingTimeSamples = 0;
        this.lastActivityAt = undefined;
    }
}
