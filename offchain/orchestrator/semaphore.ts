// orchestrator/semaphore.ts
// Concurrency control — standalone, no dependencies

export class Semaphore {
    private _active = 0;
    private _queue: Array<() => void> = [];

    constructor(private readonly capacity: number) {
        if (capacity < 1) {
            throw new Error("Semaphore capacity must be >= 1");
        }
    }

    get active(): number {
        return this._active;
    }

    get waiting(): number {
        return this._queue.length;
    }

    acquire(): Promise<void> {
        if (this._active < this.capacity) {
            this._active++;
            return Promise.resolve();
        }
        return new Promise<void>((resolve) => {
            this._queue.push(resolve);
        });
    }

    release(): void {
        const next = this._queue.shift();
        if (next) {
            // Keep _active the same — slot passes to next waiter
            next();
        } else {
            this._active--;
        }
    }

    async use<T>(fn: () => Promise<T>): Promise<T> {
        await this.acquire();
        try {
            return await fn();
        } finally {
            this.release();
        }
    }
}
