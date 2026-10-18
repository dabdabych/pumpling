// tests/unit/dex/jupiterFetch.test.ts
// Every call to Jupiter waits its turn and carries the key when there is one.
//
// Since 2026-10-18 the main buying pass is twenty minutes instead of fifty,
// and a pool of many coins on a DEX needs about one Jupiter call a second,
// over the keyless ceiling of 0.5 (developers.jup.ag, "API Rate Limit"). A 429
// there ends, after the retries, in an abandoned purchase and a refund instead
// of a buy. So the calls are spaced: these tests fail on the code before, which
// called Jupiter straight away.

import { jupiterFetch, jupiterLimiter } from "../../../dex/buy";
import { JUPITER_RATE_LIMIT } from "../../../solana/config";

const originalFetch = global.fetch;

beforeEach(() => {
    jupiterLimiter.reset();
});

afterEach(() => {
    global.fetch = originalFetch;
});

describe("jupiterFetch", () => {
    it("spaces calls under the keyless ceiling, one at a time", async () => {
        const at: number[] = [];
        global.fetch = jest.fn().mockImplementation(async () => {
            at.push(Date.now());
            return new Response("{}", { status: 200 });
        });

        await Promise.all([jupiterFetch("https://lite-api.jup.ag/a", {}, ""), jupiterFetch("https://lite-api.jup.ag/b", {}, ""), jupiterFetch("https://lite-api.jup.ag/c", {}, "")]);

        expect(JUPITER_RATE_LIMIT).toBeLessThan(0.5);
        const gap = 1000 / JUPITER_RATE_LIMIT;
        expect(at).toHaveLength(3);
        expect(at[1] - at[0]).toBeGreaterThanOrEqual(gap - 50);
        expect(at[2] - at[1]).toBeGreaterThanOrEqual(gap - 50);
        // No burst: thirty calls a minute is the ceiling on a sliding window.
        expect(jupiterLimiter.stats().intervalMs).toBeCloseTo(gap, 5);
    }, 15_000);

    it("sends the key as x-api-key, and keeps the caller's headers", async () => {
        global.fetch = jest.fn().mockResolvedValue(new Response("{}", { status: 200 }));

        await jupiterFetch("https://api.jup.ag/swap/v1/swap", { method: "POST", headers: { "content-type": "application/json" } }, "test-key");

        const [, options] = (global.fetch as jest.Mock).mock.calls[0];
        expect(options.headers).toEqual({ "content-type": "application/json", "x-api-key": "test-key" });
        expect(options.method).toBe("POST");
    });

    it("sends no key header without a key", async () => {
        global.fetch = jest.fn().mockResolvedValue(new Response("{}", { status: 200 }));

        await jupiterFetch("https://lite-api.jup.ag/swap/v1/quote", {}, "");

        const [, options] = (global.fetch as jest.Mock).mock.calls[0];
        expect(options.headers).toEqual({});
    });
});
