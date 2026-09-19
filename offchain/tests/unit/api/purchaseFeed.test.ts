// tests/unit/api/purchaseFeed.test.ts

import { buildPurchaseFeed, MAX_FEED_PURCHASES } from "../../../api/purchaseFeed";
import { LotteryState } from "../../../orchestrator/types";
import { BatchState, PurchaseRecord } from "../../../scheduler/types";

const MINT_A = "MintAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const MINT_B = "MintBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

function purchase(over: Partial<PurchaseRecord> = {}): PurchaseRecord {
    return {
        id: "p1",
        index: 1,
        scheduledAt: 1_000,
        solAmount: 0.5,
        status: "completed",
        signature: "sig1",
        attempts: 1,
        updatedAt: 1_000,
        ...over,
    } as PurchaseRecord;
}

function batch(over: Partial<BatchState> = {}): BatchState {
    return {
        runId: "run",
        mint: MINT_A,
        totalSolAmount: 2,
        purchaseCount: 4,
        config: { windowMinutes: 50, retryBufferMinutes: 5, startSlippageBps: 100, maxSlippageBps: 900 },
        purchases: [],
        summary: { completedPurchases: 0, abandonedPurchases: 0, totalSolSpent: 0, startedAt: 500 },
        ...over,
    } as BatchState;
}

function state(over: Partial<LotteryState> = {}): LotteryState {
    return {
        lotteryId: "128",
        totalSol: 10,
        sendReserve: 1,
        buyBudget: 9,
        config: {} as LotteryState["config"],
        tokenBuys: [],
        sends: [],
        summary: {
            tokensBought: 0,
            tokensFailed: 0,
            sendsTotal: 0,
            sendsCompleted: 0,
            sendsSatisfied: 0,
            sendsAbandoned: 0,
            sendsAtaMismatch: 0,
            startedAt: 100,
        },
        ...over,
    } as LotteryState;
}

describe("buildPurchaseFeed", () => {
    it("returns only completed purchases that have a signature", () => {
        const feed = buildPurchaseFeed(
            state({
                tokenBuys: [
                    { mint: MINT_A, adjustedSolAmount: 2, status: "in_progress", batchStateFile: "a.json", updatedAt: 1 },
                ],
            }),
            () =>
                batch({
                    purchases: [
                        purchase({ id: "done", index: 1, signature: "sigA", updatedAt: 2_000 }),
                        purchase({ id: "pending", index: 2, status: "pending", signature: undefined, updatedAt: 3_000 }),
                        purchase({ id: "failed", index: 3, status: "failed", signature: undefined, updatedAt: 4_000 }),
                        purchase({ id: "no-signature", index: 4, status: "completed", signature: undefined, updatedAt: 5_000 }),
                    ],
                    summary: { completedPurchases: 1, abandonedPurchases: 0, totalSolSpent: 0.5, startedAt: 500 },
                })
        );

        expect(feed.purchases).toHaveLength(1);
        expect(feed.purchases[0].signature).toBe("sigA");
        expect(feed.tokens[0].completedPurchases).toBe(1);
        expect(feed.tokens[0].spentSol).toBe(0.5);
        expect(feed.totals.completedPurchases).toBe(1);
        expect(feed.totals.plannedPurchases).toBe(4);
    });

    it("puts the newest purchase first across tokens", () => {
        const feed = buildPurchaseFeed(
            state({
                tokenBuys: [
                    { mint: MINT_A, adjustedSolAmount: 2, status: "in_progress", batchStateFile: "a.json", updatedAt: 1 },
                    { mint: MINT_B, adjustedSolAmount: 3, status: "in_progress", batchStateFile: "b.json", updatedAt: 1 },
                ],
            }),
            (filePath) =>
                filePath === "a.json"
                    ? batch({ purchases: [purchase({ signature: "old", updatedAt: 1_000 })] })
                    : batch({ mint: MINT_B, purchases: [purchase({ signature: "new", updatedAt: 9_000 })] })
        );

        expect(feed.purchases.map((item) => item.signature)).toEqual(["new", "old"]);
        expect(feed.totals.targetSol).toBe(5);
    });

    it("survives a token whose batch file is missing or broken", () => {
        const feed = buildPurchaseFeed(
            state({
                tokenBuys: [
                    { mint: MINT_A, adjustedSolAmount: 2, status: "pending", updatedAt: 1 },
                    { mint: MINT_B, adjustedSolAmount: 3, status: "in_progress", batchStateFile: "gone.json", updatedAt: 1 },
                ],
            }),
            () => null
        );

        expect(feed.purchases).toHaveLength(0);
        expect(feed.tokens).toHaveLength(2);
        expect(feed.tokens[0].spentSol).toBe(0);
        expect(feed.totals.spentSol).toBe(0);
        expect(feed.totals.targetSol).toBe(5);
    });

    it("caps the feed and keeps the newest", () => {
        const many = Array.from({ length: MAX_FEED_PURCHASES + 50 }, (_, index) =>
            purchase({ id: `p${index}`, index, signature: `sig${index}`, updatedAt: index })
        );
        const feed = buildPurchaseFeed(
            state({
                tokenBuys: [{ mint: MINT_A, adjustedSolAmount: 2, status: "in_progress", batchStateFile: "a.json", updatedAt: 1 }],
            }),
            () => batch({ purchases: many, purchaseCount: many.length })
        );

        expect(feed.purchases).toHaveLength(MAX_FEED_PURCHASES);
        expect(feed.purchases[0].signature).toBe(`sig${MAX_FEED_PURCHASES + 49}`);
    });

    it("adds up spent SOL without float tails", () => {
        const feed = buildPurchaseFeed(
            state({
                tokenBuys: [
                    { mint: MINT_A, adjustedSolAmount: 0.1, status: "completed", batchStateFile: "a.json", updatedAt: 1 },
                    { mint: MINT_B, adjustedSolAmount: 0.2, status: "completed", batchStateFile: "b.json", updatedAt: 1 },
                ],
            }),
            (filePath) =>
                batch({
                    summary: {
                        completedPurchases: 1,
                        abandonedPurchases: 0,
                        totalSolSpent: filePath === "a.json" ? 0.1 : 0.2,
                        startedAt: 1,
                    },
                })
        );

        expect(feed.totals.spentSol).toBe(0.3);
        expect(feed.totals.targetSol).toBe(0.3);
    });
});

// =============================================================================
// RECOVERY: SEVERAL BATCHES FOR ONE COIN
// =============================================================================

describe("the feed after a recovery", () => {
    it("shows purchases from every pass for a coin", () => {
        const mint = "MintA111111111111111111111111111111111111111";
        const state = {
            lotteryId: "128",
            summary: { tokensBought: 1, tokensFailed: 0, sendsTotal: 0, sendsCompleted: 0, sendsSatisfied: 0, sendsAbandoned: 0, sendsAtaMismatch: 0, startedAt: 1 },
            tokenBuys: [
                {
                    mint,
                    adjustedSolAmount: 5,
                    status: "completed",
                    batchStateFile: "batch_128_MintA111_2.json",
                    batchStateFiles: ["batch_128_MintA111_1.json", "batch_128_MintA111_2.json"],
                    updatedAt: 2,
                },
            ],
            sends: [],
        } as any;

        const batches: Record<string, any> = {
            "batch_128_MintA111_1.json": {
                purchaseCount: 2,
                summary: { totalSolSpent: 2, startedAt: 100, finishedAt: 200 },
                purchases: [
                    { index: 1, solAmount: 1, status: "completed", signature: "sig1", updatedAt: 110 },
                    { index: 2, solAmount: 1, status: "completed", signature: "sig2", updatedAt: 150 },
                ],
            },
            "batch_128_MintA111_2.json": {
                purchaseCount: 3,
                summary: { totalSolSpent: 3, startedAt: 300, finishedAt: 400 },
                purchases: [
                    { index: 1, solAmount: 3, status: "completed", signature: "sig3", updatedAt: 350 },
                    { index: 2, solAmount: 0, status: "pending", updatedAt: 360 },
                ],
            },
        };

        const feed = buildPurchaseFeed(state, (file?: string) => (file ? batches[file] ?? null : null));

        expect(feed.purchases.map((p) => p.signature)).toEqual(["sig3", "sig2", "sig1"]);
        expect(feed.tokens[0].completedPurchases).toBe(3);
        expect(feed.tokens[0].spentSol).toBe(5);
        expect(feed.tokens[0].plannedPurchases).toBe(5);
        expect(feed.tokens[0].startedAt).toBe(100);
        expect(feed.tokens[0].finishedAt).toBe(400);
        expect(feed.totals.completedPurchases).toBe(3);
    });

    it("there is no finish time until the last pass is written out", () => {
        const mint = "MintB111111111111111111111111111111111111111";
        const state = {
            lotteryId: "129",
            summary: { tokensBought: 0, tokensFailed: 0, sendsTotal: 0, sendsCompleted: 0, sendsSatisfied: 0, sendsAbandoned: 0, sendsAtaMismatch: 0, startedAt: 1 },
            tokenBuys: [{ mint, adjustedSolAmount: 4, status: "in_progress", batchStateFiles: ["one.json", "two.json"], updatedAt: 2 }],
            sends: [],
        } as any;

        const feed = buildPurchaseFeed(state, (file?: string) =>
            file === "one.json"
                ? ({ purchaseCount: 1, summary: { totalSolSpent: 1, startedAt: 10, finishedAt: 20 }, purchases: [] } as any)
                : ({ purchaseCount: 1, summary: { totalSolSpent: 0, startedAt: 30 }, purchases: [] } as any)
        );

        expect(feed.tokens[0].startedAt).toBe(10);
        expect(feed.tokens[0].finishedAt).toBeUndefined();
    });
});
