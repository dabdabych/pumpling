// tests/unit/solana/rateLimiter.test.ts
// The transaction send limiter: rate, order, burst.

import { RateLimiter } from '../../../solana/rateLimiter';

describe('RateLimiter', () => {
    describe('rate', () => {
        it('holds the given number of calls per second', async () => {
            // Ten slots at a limit of 20/sec: the first burst goes at once,
            // the rest are spread 50 ms apart.
            const limiter = new RateLimiter(20, 1);
            const started = Date.now();
            for (let index = 0; index < 10; index++) {
                await limiter.acquire();
            }
            const elapsed = Date.now() - started;

            // The point here is the lower bound: the limiter must spread the
            // slots out. The upper bound is deliberately wide — under load
            // node's timers wake late, and that says something about the
            // machine rather than the limiter.
            expect(elapsed).toBeGreaterThanOrEqual(400);
            expect(elapsed).toBeLessThan(2500);
        });

        it('no waiting when requests are rare', async () => {
            const limiter = new RateLimiter(50);
            const waited = await limiter.acquire();
            expect(waited).toBe(0);
        });
    });

    describe('burst', () => {
        it('lets a batch through after idling, but no more than allowed', async () => {
            const limiter = new RateLimiter(20, 4);
            // Building credit: the limiter is idle.
            await new Promise((resolve) => setTimeout(resolve, 250));

            const waits: number[] = [];
            for (let index = 0; index < 6; index++) {
                waits.push(await limiter.acquire());
            }

            const instant = waits.filter((wait) => wait === 0).length;
            expect(instant).toBe(4);
            expect(waits[4]).toBeGreaterThan(0);
        });

        it('credit does not build up forever', async () => {
            const limiter = new RateLimiter(100, 2);
            await new Promise((resolve) => setTimeout(resolve, 200));

            const waits: number[] = [];
            for (let index = 0; index < 5; index++) {
                waits.push(await limiter.acquire());
            }
            expect(waits.filter((wait) => wait === 0).length).toBe(2);
        });
    });

    describe('order', () => {
        it('slots are handed out in call order', async () => {
            const limiter = new RateLimiter(50, 1);
            const order: number[] = [];

            await Promise.all(
                [0, 1, 2, 3, 4].map(async (index) => {
                    await limiter.acquire();
                    order.push(index);
                })
            );

            expect(order).toEqual([0, 1, 2, 3, 4]);
        });
    });

    describe('configuration', () => {
        it('a nonsensical limit does not break the buyer', async () => {
            for (const rate of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
                const limiter = new RateLimiter(rate as number);
                const waited = await limiter.acquire();
                expect(waited).toBe(0);
                expect(limiter.stats().intervalMs).toBeGreaterThan(0);
            }
        });

        it('counts the slots handed out and the waiting', async () => {
            const limiter = new RateLimiter(20, 1);
            await limiter.acquire();
            await limiter.acquire();

            const stats = limiter.stats();
            expect(stats.granted).toBe(2);
            expect(stats.waited).toBe(1);
            expect(stats.totalWaitMs).toBeGreaterThan(0);

            limiter.reset();
            expect(limiter.stats().granted).toBe(0);
        });
    });
});
