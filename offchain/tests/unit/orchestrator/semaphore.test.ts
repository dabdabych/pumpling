// tests/unit/orchestrator/semaphore.test.ts

import { Semaphore } from "../../../orchestrator/semaphore";

describe("Semaphore", () => {
    describe("constructor", () => {
        it("should throw for capacity < 1", () => {
            expect(() => new Semaphore(0)).toThrow("capacity must be >= 1");
            expect(() => new Semaphore(-1)).toThrow("capacity must be >= 1");
        });

        it("should create with valid capacity", () => {
            const sem = new Semaphore(5);
            expect(sem.active).toBe(0);
            expect(sem.waiting).toBe(0);
        });
    });

    describe("acquire / release", () => {
        it("should acquire up to capacity without blocking", async () => {
            const sem = new Semaphore(3);

            await sem.acquire();
            await sem.acquire();
            await sem.acquire();

            expect(sem.active).toBe(3);
            expect(sem.waiting).toBe(0);
        });

        it("should queue when at capacity", async () => {
            const sem = new Semaphore(1);
            await sem.acquire();

            let acquired = false;
            const pending = sem.acquire().then(() => {
                acquired = true;
            });

            // Should not resolve immediately
            await Promise.resolve();
            expect(acquired).toBe(false);
            expect(sem.waiting).toBe(1);

            sem.release();
            await pending;
            expect(acquired).toBe(true);
        });

        it("should release decrements active", async () => {
            const sem = new Semaphore(2);
            await sem.acquire();
            await sem.acquire();
            expect(sem.active).toBe(2);

            sem.release();
            expect(sem.active).toBe(1);

            sem.release();
            expect(sem.active).toBe(0);
        });

        it("should enforce FIFO ordering", async () => {
            const sem = new Semaphore(1);
            await sem.acquire();

            const order: number[] = [];

            const p1 = sem.acquire().then(() => order.push(1));
            const p2 = sem.acquire().then(() => order.push(2));
            const p3 = sem.acquire().then(() => order.push(3));

            sem.release();
            await p1;
            sem.release();
            await p2;
            sem.release();
            await p3;

            expect(order).toEqual([1, 2, 3]);
        });
    });

    describe("use()", () => {
        it("should acquire and release around fn", async () => {
            const sem = new Semaphore(1);

            const result = await sem.use(async () => {
                expect(sem.active).toBe(1);
                return 42;
            });

            expect(result).toBe(42);
            expect(sem.active).toBe(0);
        });

        it("should release on error", async () => {
            const sem = new Semaphore(1);

            await expect(
                sem.use(async () => {
                    throw new Error("boom");
                })
            ).rejects.toThrow("boom");

            expect(sem.active).toBe(0);
        });

        it("should allow concurrent up to capacity", async () => {
            const sem = new Semaphore(3);
            let maxConcurrent = 0;
            let current = 0;

            const tasks = Array.from({ length: 10 }, (_, i) =>
                sem.use(async () => {
                    current++;
                    maxConcurrent = Math.max(maxConcurrent, current);
                    await new Promise((r) => setTimeout(r, 10));
                    current--;
                    return i;
                })
            );

            const results = await Promise.all(tasks);
            expect(results).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
            expect(maxConcurrent).toBeLessThanOrEqual(3);
            expect(maxConcurrent).toBeGreaterThan(1);
        });
    });
});
