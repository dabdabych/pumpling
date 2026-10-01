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

// =============================================================================
// WHAT THE BUYER IS DOING
// =============================================================================

/**
 * The page has to tell three states apart, and used to see none of them: it
 * counted down a fixed window whatever the buyer was doing. A round that
 * finished early left people watching an empty countdown; one that went into
 * its second pass kept buying after the countdown said it was over.
 */
describe("the phase the round is in", () => {
    const coin = (file: string) => ({
        mint: MINT_A,
        adjustedSolAmount: 2,
        status: "in_progress" as const,
        batchStateFile: file,
        updatedAt: 1,
    });

    it("buying while the main window runs", () => {
        const feed = buildPurchaseFeed(
            state({ tokenBuys: [coin("a.json")] }),
            () => batch({ purchases: [purchase()] })
        );

        expect(feed.phase).toBe("buying");
        expect(feed.fallbackEndsAt).toBeUndefined();
    });

    it("fallback once a coin goes into its second pass, with its own deadline", () => {
        const feed = buildPurchaseFeed(
            state({ tokenBuys: [coin("a.json")] }),
            () => batch({
                purchases: [purchase()],
                summary: {
                    completedPurchases: 1, abandonedPurchases: 0, totalSolSpent: 0.5,
                    startedAt: 500, retryStartedAt: 3_000, retryEndsAt: 4_000,
                },
            })
        );

        expect(feed.phase).toBe("fallback");
        expect(feed.fallbackEndsAt).toBe(4_000);
    });

    it("the deadline is the latest of them: the round waits for the slowest coin", () => {
        const feed = buildPurchaseFeed(
            state({ tokenBuys: [coin("a.json"), { ...coin("b.json"), mint: MINT_B }] }),
            (file) => batch({
                mint: file === "a.json" ? MINT_A : MINT_B,
                summary: {
                    completedPurchases: 0, abandonedPurchases: 0, totalSolSpent: 0,
                    startedAt: 500,
                    retryStartedAt: 3_000,
                    retryEndsAt: file === "a.json" ? 4_000 : 9_000,
                },
            })
        );

        expect(feed.fallbackEndsAt).toBe(9_000);
    });

    it("finished as soon as every coin's batch is written out", () => {
        const feed = buildPurchaseFeed(
            state({ tokenBuys: [coin("a.json")] }),
            () => batch({
                summary: {
                    completedPurchases: 1, abandonedPurchases: 0, totalSolSpent: 0.5,
                    startedAt: 500, finishedAt: 5_000, retryStartedAt: 3_000, retryEndsAt: 4_000,
                },
            })
        );

        // A second pass that is over is over: the deadline goes with it.
        expect(feed.phase).toBe("finished");
        expect(feed.fallbackEndsAt).toBeUndefined();
    });

    it("a coin that never got as far as a batch does not hold the round open", () => {
        const feed = buildPurchaseFeed(
            state({ tokenBuys: [{ ...coin("gone.json"), status: "failed" }] }),
            () => null
        );

        expect(feed.phase).toBe("finished");
    });

    // The start of every round: the state is written, the coins are pending,
    // and their batch files come a few seconds later. It used to say finished.
    it("buying before the first batch file exists", () => {
        const feed = buildPurchaseFeed(
            state({ tokenBuys: [
                { mint: MINT_A, adjustedSolAmount: 2, status: "pending", updatedAt: 1 },
                { mint: MINT_B, adjustedSolAmount: 3, status: "pending", updatedAt: 1 },
            ] }),
            () => null
        );

        expect(feed.phase).toBe("buying");
    });

    it("buying while a coin's batch file is named but not written yet", () => {
        const feed = buildPurchaseFeed(
            state({ tokenBuys: [coin("not-yet.json")] }),
            () => null
        );

        expect(feed.phase).toBe("buying");
    });

    it("buying while a coin waits its turn, though every started batch is done", () => {
        const feed = buildPurchaseFeed(
            state({ tokenBuys: [
                { ...coin("a.json"), status: "completed" },
                { mint: MINT_B, adjustedSolAmount: 3, status: "pending", updatedAt: 1 },
            ] }),
            (file) => file === "a.json"
                ? batch({ summary: { completedPurchases: 1, abandonedPurchases: 0, totalSolSpent: 0.5, startedAt: 500, finishedAt: 5_000 } })
                : null
        );

        expect(feed.phase).toBe("buying");
    });

    it("buying while a recovery's second batch is named but not written yet", () => {
        const feed = buildPurchaseFeed(
            state({ tokenBuys: [{ ...coin("second.json"), batchStateFiles: ["first.json", "second.json"] }] }),
            (file) => file === "first.json"
                ? batch({ summary: { completedPurchases: 1, abandonedPurchases: 0, totalSolSpent: 0.5, startedAt: 500, finishedAt: 5_000 } })
                : null
        );

        expect(feed.phase).toBe("buying");
    });

    it("finished once every coin is completed or failed, with nothing to buy", () => {
        const feed = buildPurchaseFeed(
            state({ tokenBuys: [
                { ...coin("a.json"), status: "completed" },
                { mint: MINT_B, adjustedSolAmount: 3, status: "failed", updatedAt: 1 },
            ] }),
            (file) => file === "a.json"
                ? batch({ summary: { completedPurchases: 1, abandonedPurchases: 0, totalSolSpent: 0.5, startedAt: 500, finishedAt: 5_000 } })
                : null
        );

        expect(feed.phase).toBe("finished");
    });

    it("finished once the round has written its own finish, whatever a coin still says", () => {
        const feed = buildPurchaseFeed(
            state({
                tokenBuys: [{ mint: MINT_A, adjustedSolAmount: 2, status: "pending", updatedAt: 1 }],
                summary: { ...state().summary, finishedAt: 9_000 },
            }),
            () => null
        );

        expect(feed.phase).toBe("finished");
    });
});

describe("buildPurchaseFeed: deliveries and burns", () => {
    const send = (id: string, recipient: string, amount: string | undefined, signature: string | undefined, status: string, updatedAt: number) => ({
        id, mint: MINT_A, recipient, recipientBetSol: 1, share: 0.5, sendN: 1, round: 1,
        amount, status, signature, attempts: 1, updatedAt,
    });

    it("one row per delivery transaction: the sum that arrived and who it arrived to", () => {
        const feed = buildPurchaseFeed(
            state({
                tokenBuys: [{ mint: MINT_A, adjustedSolAmount: 2, status: "in_progress", batchStateFile: "a.json", updatedAt: 1 }],
                sends: [
                    send("s1", "W1", "100", "tx1", "completed", 10),
                    send("s2", "W2", "50", "tx1", "completed", 12),
                    send("s3", "W3", "7", "tx2", "completed", 20),
                    send("s4", "W4", "9", undefined, "pending", 30),
                    send("s5", "W5", "9", "tx3", "abandoned", 40),
                ] as unknown as LotteryState["sends"],
            }),
            () => batch()
        );
        expect(feed.deliveries).toEqual([
            { mint: MINT_A, signature: "tx2", rawAmount: "7", recipients: ["W3"], at: 20 },
            { mint: MINT_A, signature: "tx1", rawAmount: "150", recipients: ["W1", "W2"], at: 12 },
        ]);
    });

    it("burns that landed, newest first; open or failed ones are not shown", () => {
        const feed = buildPurchaseFeed(
            state({
                tokenBuys: [{ mint: MINT_A, adjustedSolAmount: 2, status: "in_progress", batchStateFile: "a.json", updatedAt: 1 }],
                burns: [
                    { id: "b1", mint: MINT_A, rawAmount: "5", status: "completed", signature: "burn1", attempts: 1, createdAt: 1, updatedAt: 100 },
                    { id: "b2", mint: MINT_A, rawAmount: "6", status: "completed", signature: "burn2", attempts: 1, createdAt: 1, updatedAt: 200 },
                    { id: "b3", mint: MINT_A, rawAmount: "7", status: "in_progress", pendingSignature: "burn3", attempts: 1, createdAt: 1, updatedAt: 300 },
                    { id: "b4", mint: MINT_A, rawAmount: "8", status: "failed", attempts: 1, createdAt: 1, updatedAt: 400 },
                ],
            }),
            () => batch()
        );
        expect(feed.burns.map((b) => b.signature)).toEqual(["burn2", "burn1"]);
    });

    it("a coin with burners carries where its burn stands; one without carries none", () => {
        const feed = buildPurchaseFeed(
            state({
                tokenBuys: [
                    {
                        mint: MINT_A, adjustedSolAmount: 2, status: "completed", batchStateFile: "a.json", updatedAt: 1,
                        decimals: 6, burnedRaw: "250", supplyAtStart: "1000000", supplyAtEnd: "999750",
                        burnBlocked: { reason: "the coin's mint is paused", at: 5 },
                        recipients: [
                            { wallet: "W1", stakeLamports: "1000", burnBps: 5000, burnWeight: "5000000" },
                            { wallet: "W2", stakeLamports: "1000", burnBps: 0, burnWeight: "0" },
                        ],
                    },
                    { mint: MINT_B, adjustedSolAmount: 1, status: "completed", batchStateFile: "b.json", updatedAt: 1 },
                ],
                purchaseTokens: { sigA: "600", sigB: "400" },
            }),
            (file) => file === "a.json"
                ? batch({ purchases: [purchase({ id: "a", signature: "sigA" }), purchase({ id: "b", index: 2, signature: "sigB" })] })
                : batch({ mint: MINT_B })
        );
        const [a, b] = feed.tokens;
        expect(a.decimals).toBe(6);
        expect(a.burnBps).toBe(2500);
        expect(a.burn).toEqual({
            boughtRaw: "1000",
            owedRaw: "250",
            burnedRaw: "250",
            blockedReason: "the coin's mint is paused",
            supplyAtStart: "1000000",
            supplyAtEnd: "999750",
        });
        expect(b.burnBps).toBe(0);
        expect(b.burn).toBeUndefined();
    });

    it("an older state has neither: empty lists, not a crash", () => {
        const feed = buildPurchaseFeed(state(), () => null);
        expect(feed.deliveries).toEqual([]);
        expect(feed.burns).toEqual([]);
    });
});


describe("buildPurchaseFeed: refunds", () => {
    const refund = (id: string, mint: string, recipient: string, amountSol: number, signature: string | undefined, status: string, updatedAt: number) => ({
        id, mint, recipient, grossSol: amountSol, feeSol: 0, amountSol, status, signature, attempts: 1, updatedAt,
    });

    it("one row per transaction and coin, with what arrived and to whom; nothing unsent", () => {
        const feed = buildPurchaseFeed(
            state({
                refunds: [
                    refund("r1", MINT_A, "W1", 0.4, "tx1", "completed", 10),
                    refund("r2", MINT_A, "W2", 0.1, "tx1", "completed", 12),
                    refund("r3", MINT_B, "W3", 0.25, "tx1", "completed", 12),
                    refund("r4", MINT_A, "W4", 0.2, "tx2", "completed", 30),
                    refund("r5", MINT_A, "W5", 0, undefined, "skipped", 40),
                    refund("r6", MINT_A, "W6", 0.3, undefined, "pending", 50),
                    refund("r7", MINT_A, "W7", 0.3, "tx3", "failed", 60),
                ] as unknown as LotteryState["refunds"],
            }),
            () => batch()
        );
        expect(feed.refunds).toEqual([
            { mint: MINT_A, signature: "tx2", sol: 0.2, recipients: ["W4"], at: 30 },
            { mint: MINT_A, signature: "tx1", sol: 0.5, recipients: ["W1", "W2"], at: 12 },
            { mint: MINT_B, signature: "tx1", sol: 0.25, recipients: ["W3"], at: 12 },
        ]);
    });

    it("an older state has none", () => {
        expect(buildPurchaseFeed(state(), () => null).refunds).toEqual([]);
    });
});
