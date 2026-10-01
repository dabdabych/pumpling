// tests/unit/solana/rebroadcast.test.ts
//
// A purchase stays on the wire until it lands or its blockhash expires, and
// nothing new is ever signed on the way.

import { TransactionExpiredBlockheightExceededError } from "@solana/web3.js";

import { sendAndConfirmWithRebroadcast } from "../../../solana/rebroadcast";

const STRATEGY = { signature: "sig-1", blockhash: "hash-1", lastValidBlockHeight: 1_000 };
const RAW = Buffer.from([1, 2, 3, 4]);

/** A clock the test moves by hand: each `tick()` ends one interval. */
function manualClock() {
    const waiting: Array<() => void> = [];
    return {
        sleep: () => new Promise<void>((resolve) => waiting.push(resolve)),
        async tick() {
            // Let the loop reach its sleep, end that interval, let it run to the next one.
            for (let i = 0; i < 10; i++) await Promise.resolve();
            const next = waiting.shift();
            next?.();
            for (let i = 0; i < 10; i++) await Promise.resolve();
        },
    };
}

function fakeConnection() {
    let settle!: (value: unknown) => void;
    let fail!: (error: unknown) => void;
    const confirmation = new Promise((resolve, reject) => {
        settle = resolve;
        fail = reject;
    });
    const sends: Array<{ raw: Buffer | Uint8Array; options: unknown }> = [];
    let sendError: Error | null = null;
    return {
        sends,
        failNextSends(error: Error | null) {
            sendError = error;
        },
        land: () => settle({ context: { slot: 9 }, value: { err: null } }),
        landFailed: () => settle({ context: { slot: 9 }, value: { err: { InstructionError: [0, "Custom"] } } }),
        expire: () => fail(new TransactionExpiredBlockheightExceededError(STRATEGY.signature)),
        connection: {
            async sendRawTransaction(raw: Buffer | Uint8Array, options: unknown) {
                sends.push({ raw, options });
                if (sendError && sends.length > 1) throw sendError;
                return STRATEGY.signature;
            },
            confirmTransaction: () => confirmation,
        },
    };
}

describe("sendAndConfirmWithRebroadcast", () => {
    it("sends the same bytes again every interval until the purchase lands, and not after", async () => {
        const clock = manualClock();
        const node = fakeConnection();
        const acquired: number[] = [];
        const done = sendAndConfirmWithRebroadcast(RAW, STRATEGY, {
            connection: node.connection as never,
            sleep: clock.sleep,
            acquire: async () => { acquired.push(node.sends.length); },
        });

        await clock.tick();
        await clock.tick();
        await clock.tick();
        expect(node.sends).toHaveLength(4);
        node.land();
        const result = await done;
        await clock.tick();
        await clock.tick();

        expect(result.value.err).toBeNull();
        // Nothing went out after the confirmation.
        expect(node.sends).toHaveLength(4);
        // The same bytes every time: nothing was signed again.
        expect(node.sends.every((send) => send.raw === RAW)).toBe(true);
        // No preflight, and the node's own retries off: we retry.
        expect(node.sends.every((send) => JSON.stringify(send.options) === JSON.stringify({ skipPreflight: true, maxRetries: 0 }))).toBe(true);
        // Every resend waited its turn in the send queue; the first did not,
        // its caller queued before signing.
        expect(acquired).toEqual([1, 2, 3]);
    });

    it("reports a transaction that landed and failed as the confirmation does", async () => {
        const clock = manualClock();
        const node = fakeConnection();
        const done = sendAndConfirmWithRebroadcast(RAW, STRATEGY, { connection: node.connection as never, sleep: clock.sleep, acquire: async () => undefined });
        node.landFailed();
        const result = await done;
        expect(result.value.err).toEqual({ InstructionError: [0, "Custom"] });
    });

    it("stops at expiry and lets the expiry through unchanged", async () => {
        const clock = manualClock();
        const node = fakeConnection();
        const done = sendAndConfirmWithRebroadcast(RAW, STRATEGY, { connection: node.connection as never, sleep: clock.sleep, acquire: async () => undefined });
        await clock.tick();
        node.expire();
        await expect(done).rejects.toBeInstanceOf(TransactionExpiredBlockheightExceededError);
        await expect(done).rejects.toThrow(/block height exceeded/);
        const sentBefore = node.sends.length;
        await clock.tick();
        await clock.tick();
        expect(node.sends).toHaveLength(sentBefore);
    });

    it("keeps waiting through failed resends: they say nothing about the outcome", async () => {
        const clock = manualClock();
        const node = fakeConnection();
        node.failNextSends(new Error("This transaction has already been processed"));
        const done = sendAndConfirmWithRebroadcast(RAW, STRATEGY, { connection: node.connection as never, sleep: clock.sleep, acquire: async () => undefined });
        await clock.tick();
        await clock.tick();
        node.land();
        await expect(done).resolves.toMatchObject({ value: { err: null } });
    });

    it("a failed first send is not swallowed: nothing may be on the wire", async () => {
        const clock = manualClock();
        const node = fakeConnection();
        const connection = {
            ...node.connection,
            async sendRawTransaction() { throw new Error("connection refused"); },
        };
        await expect(
            sendAndConfirmWithRebroadcast(RAW, STRATEGY, { connection: connection as never, sleep: clock.sleep, acquire: async () => undefined })
        ).rejects.toThrow("connection refused");
    });
});
