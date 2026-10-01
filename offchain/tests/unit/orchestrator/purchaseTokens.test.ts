// tests/unit/orchestrator/purchaseTokens.test.ts
//
// B, what a coin's purchases brought, read from the purchases themselves.

import { Keypair } from "@solana/web3.js";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { PENDING_FINAL_AFTER_MS, refreshPurchaseTokens, tokensBought } from "../../../orchestrator/purchaseTokens";
import { OrchestratorStateManager } from "../../../orchestrator/state";
import { LotteryState } from "../../../orchestrator/types";
import { BatchState } from "../../../scheduler/types";

const MINT = "MintAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const OTHER = "MintBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const keeper = Keypair.generate().publicKey;
const NOW = 2_000_000_000_000;

function batch(purchases: Array<Record<string, unknown>>): BatchState {
    return { runId: "r", mint: MINT, purchases, summary: {} } as unknown as BatchState;
}

function setup(purchases: Array<Record<string, unknown>>) {
    const state: LotteryState = {
        lotteryId: "t", totalSol: 1, sendReserve: 0, buyBudget: 1,
        config: {} as LotteryState["config"],
        tokenBuys: [{ mint: MINT, adjustedSolAmount: 1, status: "in_progress", batchStateFile: "b.json", updatedAt: 1 }],
        sends: [],
        summary: {} as LotteryState["summary"],
    };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "purchase-tokens-"));
    const stateManager = OrchestratorStateManager.create(state, path.join(dir, "s.json"));
    const loadBatch = () => batch(purchases);
    return { stateManager, loadBatch };
}

/** A node that knows these transactions: signature → keeper's token delta per mint. */
function node(known: Record<string, Record<string, bigint> | null>, failing = new Set<string>()) {
    const calls: string[][] = [];
    const rpcBatch = async (body: unknown[]) => {
        const requests = body as Array<{ id: number; params: [string] }>;
        calls.push(requests.map((request) => request.params[0]));
        return requests.map((request) => {
            const signature = request.params[0];
            if (failing.has(signature)) {
                return { jsonrpc: "2.0", id: request.id, error: { code: -32000, message: "boom" } };
            }
            const deltas = known[signature];
            if (deltas === undefined || deltas === null) {
                return { jsonrpc: "2.0", id: request.id, result: null };
            }
            return {
                jsonrpc: "2.0",
                id: request.id,
                result: {
                    meta: {
                        err: null, preBalances: [10], postBalances: [5], preTokenBalances: [],
                        postTokenBalances: Object.entries(deltas).map(([mint, amount]) => ({
                            mint, owner: keeper.toBase58(), uiTokenAmount: { amount: amount.toString() },
                        })),
                    },
                    transaction: { message: { accountKeys: [{ pubkey: keeper.toBase58() }] } },
                },
            };
        });
    };
    return { rpcBatch, calls };
}

const quiet = { info: jest.fn(), warn: jest.fn() } as never;

describe("tokensBought and refreshPurchaseTokens", () => {
    it("counts completed purchases once read, and only this coin's tokens", async () => {
        const { stateManager, loadBatch } = setup([
            { index: 1, status: "completed", signature: "s1", updatedAt: NOW },
            { index: 2, status: "completed", signature: "s2", updatedAt: NOW },
            { index: 3, status: "failed", updatedAt: NOW },
        ]);
        expect(tokensBought(stateManager.getState(), MINT, loadBatch)).toEqual({ known: 0n, unread: ["s1", "s2"], unreadPending: [] });

        const { rpcBatch, calls } = node({ s1: { [MINT]: 100n, [OTHER]: 7n }, s2: { [MINT]: 50n } });
        await refreshPurchaseTokens(stateManager, keeper, [MINT], loadBatch, { rpcBatch, logger: quiet, now: () => NOW });
        expect(tokensBought(stateManager.getState(), MINT, loadBatch).known).toBe(150n);

        // Read once: a second refresh asks nothing.
        await refreshPurchaseTokens(stateManager, keeper, [MINT], loadBatch, { rpcBatch, logger: quiet, now: () => NOW });
        expect(calls).toHaveLength(1);
    });

    it("a completed purchase the node does not have yet stays unread and is asked again", async () => {
        const { stateManager, loadBatch } = setup([{ index: 1, status: "completed", signature: "late", updatedAt: NOW }]);
        const lagging = node({});
        await refreshPurchaseTokens(stateManager, keeper, [MINT], loadBatch, { rpcBatch: lagging.rpcBatch, logger: quiet, now: () => NOW + 3_600_000 });
        expect(tokensBought(stateManager.getState(), MINT, loadBatch)).toEqual({ known: 0n, unread: ["late"], unreadPending: [] });

        const caughtUp = node({ late: { [MINT]: 42n } });
        await refreshPurchaseTokens(stateManager, keeper, [MINT], loadBatch, { rpcBatch: caughtUp.rpcBatch, logger: quiet, now: () => NOW });
        expect(tokensBought(stateManager.getState(), MINT, loadBatch).known).toBe(42n);
    });

    it("an error row or a failed request records nothing", async () => {
        const { stateManager, loadBatch } = setup([{ index: 1, status: "completed", signature: "s1", updatedAt: NOW }]);
        const erroring = node({ s1: { [MINT]: 1n } }, new Set(["s1"]));
        await refreshPurchaseTokens(stateManager, keeper, [MINT], loadBatch, { rpcBatch: erroring.rpcBatch, logger: quiet, now: () => NOW });
        expect(stateManager.getState().purchaseTokens?.s1).toBeUndefined();

        await refreshPurchaseTokens(stateManager, keeper, [MINT], loadBatch, {
            rpcBatch: async () => { throw new Error("HTTP 503"); }, logger: quiet, now: () => NOW,
        });
        expect(stateManager.getState().purchaseTokens?.s1).toBeUndefined();
    });

    it("an earlier attempt that quietly landed bought too, and counts", async () => {
        const { stateManager, loadBatch } = setup([
            { index: 1, status: "completed", signature: "second", pendingSignature: "first", updatedAt: NOW },
        ]);
        const { rpcBatch } = node({ second: { [MINT]: 30n }, first: { [MINT]: 29n } });
        await refreshPurchaseTokens(stateManager, keeper, [MINT], loadBatch, { rpcBatch, logger: quiet, now: () => NOW });
        expect(tokensBought(stateManager.getState(), MINT, loadBatch)).toEqual({ known: 59n, unread: [], unreadPending: [] });
    });

    it("an earlier attempt not on chain is zero only once it is surely expired", async () => {
        const { stateManager, loadBatch } = setup([
            { index: 1, status: "failed", pendingSignature: "maybe", updatedAt: NOW },
        ]);
        const { rpcBatch } = node({});
        // A minute later it could still land: not decided.
        await refreshPurchaseTokens(stateManager, keeper, [MINT], loadBatch, { rpcBatch, logger: quiet, now: () => NOW + 60_000 });
        expect(tokensBought(stateManager.getState(), MINT, loadBatch).unreadPending).toEqual(["maybe"]);
        // Past the limit it cannot: zero, and never asked again.
        await refreshPurchaseTokens(stateManager, keeper, [MINT], loadBatch, { rpcBatch, logger: quiet, now: () => NOW + PENDING_FINAL_AFTER_MS + 1 });
        expect(stateManager.getState().purchaseTokens?.maybe).toBe("0");
        expect(tokensBought(stateManager.getState(), MINT, loadBatch)).toEqual({ known: 0n, unread: [], unreadPending: [] });
    });

    // A purchase signed again after its blockhash ran out has several attempts,
    // and only the last one used to be on the record. Whichever landed bought.
    it("every attempt the purchase sent counts, not only the last", async () => {
        const { stateManager, loadBatch } = setup([
            {
                index: 1, status: "completed", signature: "third", pendingSignature: "third", updatedAt: NOW,
                sentAttempts: [
                    { signature: "first", lastValidBlockHeight: 1, at: NOW - 120_000 },
                    { signature: "second", lastValidBlockHeight: 2, at: NOW - 60_000 },
                    { signature: "third", lastValidBlockHeight: 3, at: NOW },
                ],
            },
        ]);
        // "first" quietly landed; "second" never did.
        const { rpcBatch } = node({ third: { [MINT]: 30n }, first: { [MINT]: 29n } });
        await refreshPurchaseTokens(stateManager, keeper, [MINT], loadBatch, { rpcBatch, logger: quiet, now: () => NOW + PENDING_FINAL_AFTER_MS + 1 });
        expect(tokensBought(stateManager.getState(), MINT, loadBatch)).toEqual({ known: 59n, unread: [], unreadPending: [] });
        expect(stateManager.getState().purchaseTokens?.second).toBe("0");
    });

    it("an unread earlier attempt never holds B back", () => {
        const { stateManager, loadBatch } = setup([
            { index: 1, status: "completed", signature: "ok", pendingSignature: "first", updatedAt: NOW },
        ]);
        stateManager.recordPurchaseTokens(new Map([["ok", 10n]]));
        const bought = tokensBought(stateManager.getState(), MINT, loadBatch);
        expect(bought.known).toBe(10n);
        expect(bought.unread).toEqual([]);
        expect(bought.unreadPending).toEqual(["first"]);
    });
});
