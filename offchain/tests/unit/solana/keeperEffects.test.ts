// tests/unit/solana/keeperEffects.test.ts
//
// What a transaction did to one wallet, read from a node's `jsonParsed` answer.
// The fixtures are real mainnet transactions, one of each version, fetched on
// 2026-09-29 with `maxSupportedTransactionVersion: 1` and trimmed to the fields
// the reader uses: a v1 transaction (59 accounts), a v0 one that loads accounts
// from a lookup table, and a legacy purchase from round 1790348400190.
//
// The expected figures are worked out here, independently of the code under
// test, straight from the balances in the answer.

import { Keypair } from "@solana/web3.js";

import { effectFrom, readKeeperEffects } from "../../../solana/debits";
import fixtures from "./fixtures/transactions-by-version.json";

type Row = { owner?: string; mint: string; uiTokenAmount: { amount: string } };
type Result = {
    version: unknown;
    meta: { err: unknown; preBalances: number[]; postBalances: number[]; preTokenBalances: Row[]; postTokenBalances: Row[] };
    transaction: { message: { accountKeys: Array<{ pubkey: string }> } };
};

const samples = fixtures as unknown as Record<"v1" | "v0" | "legacy", { signature: string; result: Result }>;

function expectedDeltas(result: Result, owner: string): Map<string, bigint> {
    const deltas = new Map<string, bigint>();
    for (const row of result.meta.postTokenBalances.filter((r) => r.owner === owner)) {
        deltas.set(row.mint, (deltas.get(row.mint) ?? 0n) + BigInt(row.uiTokenAmount.amount));
    }
    for (const row of result.meta.preTokenBalances.filter((r) => r.owner === owner)) {
        deltas.set(row.mint, (deltas.get(row.mint) ?? 0n) - BigInt(row.uiTokenAmount.amount));
    }
    return deltas;
}

describe("effectFrom on real transactions of every version", () => {
    for (const version of ["v1", "v0", "legacy"] as const) {
        it(`${version}: the fee payer's SOL and token changes`, () => {
            const { result } = samples[version];
            const payer = result.transaction.message.accountKeys[0].pubkey;
            const effect = effectFrom(result, payer);
            expect(effect).not.toBeNull();
            expect(effect!.found).toBe(true);
            expect(effect!.failedOnChain).toBe(false);
            expect(effect!.debitSol).toBeCloseTo((result.meta.preBalances[0] - result.meta.postBalances[0]) / 1e9, 12);
            expect(effect!.tokenDeltas).toEqual(expectedDeltas(result, payer));
        });

        it(`${version}: any other owner's token changes`, () => {
            const { result } = samples[version];
            const owners = [...new Set(result.meta.postTokenBalances.map((row) => row.owner).filter((o): o is string => !!o))];
            expect(owners.length).toBeGreaterThan(0);
            for (const owner of owners) {
                expect(effectFrom(result, owner)!.tokenDeltas).toEqual(expectedDeltas(result, owner));
            }
        });
    }

    it("the legacy purchase brought what the replay says", () => {
        const { result } = samples.legacy;
        const payer = result.transaction.message.accountKeys[0].pubkey;
        const effect = effectFrom(result, payer)!;
        expect(effect.tokenDeltas.get("56AsKxgMEVXcXSdqgzHHcPGJ7owdJwzfd9GyRvh8pump")).toBe(3_878_138_814_783n);
    });

    it("a node answering null: the transaction is not on chain", () => {
        expect(effectFrom(null, "x")).toEqual({ found: false, debitSol: 0, tokenDeltas: new Map(), failedOnChain: false });
    });

    it("an answer it cannot read is unknown, not zero", () => {
        expect(effectFrom({}, "x")).toBeNull();
        expect(effectFrom({ meta: null }, "x")).toBeNull();
        expect(effectFrom("junk", "x")).toBeNull();
    });
});

describe("readKeeperEffects", () => {
    const keeper = Keypair.generate().publicKey;

    it("asks for version 1, in jsonParsed, in batches, and keeps rows apart", async () => {
        const bodies: unknown[][] = [];
        const rpcBatch = jest.fn(async (body: unknown[]) => {
            bodies.push(body);
            return (body as Array<{ id: number; params: [string, unknown] }>).map((request) => ({
                jsonrpc: "2.0",
                id: request.id,
                // One row fails, one is not on chain, the rest are the legacy sample.
                ...(request.params[0] === "bad"
                    ? { error: { code: -32015, message: "Transaction version (1) is not supported" } }
                    : { result: request.params[0] === "gone" ? null : samples.legacy.result }),
            }));
        });
        const signatures = ["a", "b", "bad", "gone", "a"];
        const effects = await readKeeperEffects(signatures, keeper, { rpcBatch, batchSize: 2, pauseMs: 0 });

        expect(bodies.map((body) => body.length)).toEqual([2, 2]);
        for (const body of bodies) {
            for (const request of body as Array<{ method: string; params: [string, Record<string, unknown>] }>) {
                expect(request.method).toBe("getTransaction");
                expect(request.params[1]).toEqual({ encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: 1 });
            }
        }
        expect(effects.get("a")?.found).toBe(true);
        expect(effects.get("b")?.found).toBe(true);
        // An error row is unknown: left out, never taken as "not on chain".
        expect(effects.has("bad")).toBe(false);
        expect(effects.get("gone")?.found).toBe(false);
    });

    it("a failed request, asked twice, leaves everything in it unknown and does not throw", async () => {
        const rpcBatch = jest.fn(async () => {
            throw new Error("RPC batch failed with HTTP 429");
        });
        const effects = await readKeeperEffects(["a", "b"], keeper, {
            rpcBatch,
            logger: { warn: jest.fn() } as never,
            retryAfterMs: 0,
        });
        expect(effects.size).toBe(0);
        expect(rpcBatch).toHaveBeenCalledTimes(2);
    });

    it("a batch refused once is asked again and read", async () => {
        let calls = 0;
        const rpcBatch = jest.fn(async (body: unknown[]) => {
            calls += 1;
            if (calls === 1) {
                throw new Error("RPC batch failed with HTTP 429");
            }
            return (body as Array<{ id: number }>).map((request) => ({ jsonrpc: "2.0", id: request.id, result: samples.legacy.result }));
        });
        const effects = await readKeeperEffects(["a"], keeper, { rpcBatch, retryAfterMs: 0 });
        expect(effects.get("a")?.found).toBe(true);
    });

    it("reads in small paced batches", async () => {
        const sizes: number[] = [];
        const stamps: number[] = [];
        const rpcBatch = jest.fn(async (body: unknown[]) => {
            sizes.push(body.length);
            stamps.push(Date.now());
            return (body as Array<{ id: number }>).map((request) => ({ jsonrpc: "2.0", id: request.id, result: null }));
        });
        const signatures = Array.from({ length: 23 }, (_, i) => `s${i}`);
        await readKeeperEffects(signatures, keeper, { rpcBatch, pauseMs: 40 });
        expect(sizes).toEqual([10, 10, 3]);
        expect(stamps[1] - stamps[0]).toBeGreaterThanOrEqual(35);
        expect(stamps[2] - stamps[1]).toBeGreaterThanOrEqual(35);
    });
});
