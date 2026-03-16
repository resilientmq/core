import { MetricsCollector, ResilientMQMetrics } from '../../../src/metrics/metrics-collector';

describe('MetricsCollector', () => {
    let collector: MetricsCollector;

    beforeEach(() => {
        collector = new MetricsCollector();
    });

    // ─── Initial state ──────────────────────────────────────────────────────────

    describe('initial state', () => {
        it('should return zeroed counters on fresh instance', () => {
            const snap = collector.getSnapshot();
            expect(snap.messagesReceived).toBe(0);
            expect(snap.messagesProcessed).toBe(0);
            expect(snap.messagesRetried).toBe(0);
            expect(snap.messagesFailed).toBe(0);
            expect(snap.messagesSentToDLQ).toBe(0);
            expect(snap.messagesPublished).toBe(0);
            expect(snap.processingErrors).toBe(0);
            expect(snap.avgProcessingTimeMs).toBe(0);
            expect(snap.lastActivityAt).toBeUndefined();
        });
    });

    // ─── increment ──────────────────────────────────────────────────────────────

    describe('increment()', () => {
        const counterKeys: Array<keyof Omit<ResilientMQMetrics, 'avgProcessingTimeMs' | 'lastActivityAt'>> = [
            'messagesReceived',
            'messagesProcessed',
            'messagesRetried',
            'messagesFailed',
            'messagesSentToDLQ',
            'messagesPublished',
            'processingErrors',
        ];

        it.each(counterKeys)('should increment %s by 1', (key) => {
            collector.increment(key);
            expect(collector.getSnapshot()[key]).toBe(1);
        });

        it('should accumulate multiple increments', () => {
            collector.increment('messagesReceived');
            collector.increment('messagesReceived');
            collector.increment('messagesReceived');
            expect(collector.getSnapshot().messagesReceived).toBe(3);
        });

        it('should set lastActivityAt when incrementing', () => {
            const before = new Date();
            collector.increment('messagesReceived');
            const after = new Date();
            const snap = collector.getSnapshot();
            expect(snap.lastActivityAt).toBeDefined();
            expect(snap.lastActivityAt!.getTime()).toBeGreaterThanOrEqual(before.getTime());
            expect(snap.lastActivityAt!.getTime()).toBeLessThanOrEqual(after.getTime());
        });

        it('should update lastActivityAt on each increment', () => {
            collector.increment('messagesReceived');
            const first = collector.getSnapshot().lastActivityAt!.getTime();
            collector.increment('messagesProcessed');
            const second = collector.getSnapshot().lastActivityAt!.getTime();
            expect(second).toBeGreaterThanOrEqual(first);
        });
    });

    // ─── recordProcessingTime ───────────────────────────────────────────────────

    describe('recordProcessingTime()', () => {
        it('should compute avgProcessingTimeMs from a single sample', () => {
            collector.recordProcessingTime(100);
            expect(collector.getSnapshot().avgProcessingTimeMs).toBe(100);
        });

        it('should compute avgProcessingTimeMs from multiple samples', () => {
            collector.recordProcessingTime(100);
            collector.recordProcessingTime(200);
            collector.recordProcessingTime(300);
            expect(collector.getSnapshot().avgProcessingTimeMs).toBe(200);
        });

        it('should set lastActivityAt when recording processing time', () => {
            const before = new Date();
            collector.recordProcessingTime(50);
            const after = new Date();
            const snap = collector.getSnapshot();
            expect(snap.lastActivityAt).toBeDefined();
            expect(snap.lastActivityAt!.getTime()).toBeGreaterThanOrEqual(before.getTime());
            expect(snap.lastActivityAt!.getTime()).toBeLessThanOrEqual(after.getTime());
        });

        it('should return 0 avgProcessingTimeMs when no samples recorded', () => {
            expect(collector.getSnapshot().avgProcessingTimeMs).toBe(0);
        });
    });

    // ─── getSnapshot ────────────────────────────────────────────────────────────

    describe('getSnapshot()', () => {
        it('should return an immutable copy (not the internal state)', () => {
            collector.increment('messagesReceived');
            const snap1 = collector.getSnapshot();
            collector.increment('messagesReceived');
            const snap2 = collector.getSnapshot();
            expect(snap1.messagesReceived).toBe(1);
            expect(snap2.messagesReceived).toBe(2);
        });

        it('should include all metric fields', () => {
            const snap = collector.getSnapshot();
            const expectedKeys: Array<keyof ResilientMQMetrics> = [
                'messagesReceived',
                'messagesProcessed',
                'messagesRetried',
                'messagesFailed',
                'messagesSentToDLQ',
                'messagesPublished',
                'processingErrors',
                'avgProcessingTimeMs',
                'lastActivityAt',
            ];
            for (const key of expectedKeys) {
                expect(snap).toHaveProperty(key);
            }
        });
    });

    // ─── reset ──────────────────────────────────────────────────────────────────

    describe('reset()', () => {
        it('should reset all counters to zero', () => {
            collector.increment('messagesReceived');
            collector.increment('messagesProcessed');
            collector.increment('processingErrors');
            collector.recordProcessingTime(200);
            collector.reset();

            const snap = collector.getSnapshot();
            expect(snap.messagesReceived).toBe(0);
            expect(snap.messagesProcessed).toBe(0);
            expect(snap.processingErrors).toBe(0);
            expect(snap.avgProcessingTimeMs).toBe(0);
            expect(snap.lastActivityAt).toBeUndefined();
        });

        it('should allow accumulation after reset', () => {
            collector.increment('messagesPublished');
            collector.reset();
            collector.increment('messagesPublished');
            collector.increment('messagesPublished');
            expect(collector.getSnapshot().messagesPublished).toBe(2);
        });

        it('should reset lastActivityAt to undefined', () => {
            collector.increment('messagesReceived');
            collector.reset();
            expect(collector.getSnapshot().lastActivityAt).toBeUndefined();
        });

        it('should reset avgProcessingTimeMs to 0 after recording times', () => {
            collector.recordProcessingTime(100);
            collector.recordProcessingTime(200);
            collector.reset();
            expect(collector.getSnapshot().avgProcessingTimeMs).toBe(0);
        });
    });

    // ─── Combined scenarios ─────────────────────────────────────────────────────

    describe('combined usage', () => {
        it('should track a full message lifecycle', () => {
            collector.increment('messagesReceived');
            collector.recordProcessingTime(50);
            collector.increment('messagesProcessed');

            const snap = collector.getSnapshot();
            expect(snap.messagesReceived).toBe(1);
            expect(snap.messagesProcessed).toBe(1);
            expect(snap.avgProcessingTimeMs).toBe(50);
        });

        it('should track retry and failure lifecycle', () => {
            collector.increment('messagesReceived');
            collector.increment('messagesRetried');
            collector.increment('messagesRetried');
            collector.increment('messagesFailed');
            collector.increment('messagesSentToDLQ');
            collector.increment('processingErrors');

            const snap = collector.getSnapshot();
            expect(snap.messagesRetried).toBe(2);
            expect(snap.messagesFailed).toBe(1);
            expect(snap.messagesSentToDLQ).toBe(1);
            expect(snap.processingErrors).toBe(1);
        });
    });
});
