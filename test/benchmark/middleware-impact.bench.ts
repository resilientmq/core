import {writeFileSync} from 'fs';
import {join} from 'path';
import {applyMiddleware} from '../../src/resilience/middleware';
import {EventMessage, Middleware} from '../../src/types';

type MiddlewareResult = {
    middlewareCount: number;
    iterations: number;
    durationMs: number;
    throughput: number;
    averageLatencyMicroseconds: number;
};

/** Isolates the asynchronous middleware composition cost from RabbitMQ and publisher confirms. */
describe('Benchmark: middleware impact', () => {
    const iterations = 100000;
    const results: MiddlewareResult[] = [];
    const event: EventMessage = {
        messageId: 'middleware-benchmark',
        type: 'benchmark.middleware',
        payload: {value: 1}
    };

    afterAll(() => {
        const baseline = results.find(result => result.middlewareCount === 0)!.averageLatencyMicroseconds;
        writeFileSync(
            join(__dirname, '../../test-results/benchmark-middleware-impact.json'),
            JSON.stringify({
                benchmark: 'middleware-impact',
                timestamp: new Date().toISOString(),
                baselineLatencyMicroseconds: baseline,
                results: results.map(result => ({
                    ...result,
                    addedLatencyMicroseconds: result.averageLatencyMicroseconds - baseline
                }))
            }, null, 2),
            'utf8'
        );
    });

    for (const middlewareCount of [0, 1, 3, 5]) {
        it(`measures ${middlewareCount} middleware functions`, async () => {
            const middleware: Middleware[] = Array.from({length: middlewareCount}, () =>
                async (_event, next) => next()
            );
            const handler = async () => undefined;
            for (let index = 0; index < 1000; index++) {
                await applyMiddleware(middleware, event, handler);
            }

            const startedAt = performance.now();
            for (let index = 0; index < iterations; index++) {
                await applyMiddleware(middleware, event, handler);
            }
            const durationMs = performance.now() - startedAt;
            const throughput = iterations / (durationMs / 1000);
            const averageLatencyMicroseconds = (durationMs * 1000) / iterations;
            results.push({middlewareCount, iterations, durationMs, throughput, averageLatencyMicroseconds});

            console.log(
                `middleware=${middlewareCount}: ${throughput.toFixed(0)} ops/s, `
                + `${averageLatencyMicroseconds.toFixed(3)}us/event`
            );
            expect(Number.isFinite(averageLatencyMicroseconds)).toBe(true);
            expect(averageLatencyMicroseconds).toBeGreaterThan(0);
        });
    }
});
