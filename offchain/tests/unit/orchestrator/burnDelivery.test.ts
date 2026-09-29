// tests/unit/orchestrator/burnDelivery.test.ts
//
// The burn's whole promise, checked end to end on a fake chain.
//
//   delivered to i = B × s_i × (10000 − bps_i) / (S × 10000)
//   burned         = B × Σ(s_i × bps_i)      / (S × 10000)
//
// Nothing here re-implements the buyer. The delivery rounds, the burns, the
// settlement after the buying, the sweep and the last attempts at a burn are
// the real functions, in the order `runBuyAndSend` calls them. What is fake is
// the chain underneath: a token balance, the transfers and burns it accepts,
// the signatures it can answer for, and the node's answers to `getTransaction`
// — the same JSON a real node returns, so the reading of purchases is real too.
//
// Purchases land at random moments between the rounds, and some land after the
// last round, the way purchase #28 of round 1790348400190 did.
//
// The same harness run with the buyer told that nobody burns — while the
// tokens are burned all the same — is the old formula, which divided what was
// left by the commits of the people still being delivered to. It must fail,
// or passing here would mean nothing.

import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import pino from "pino";

interface MockChain {
    keeper: string;
    mint: string;
    balance: bigint;
    /** What a node that has not caught up reports: the balance before the last change. */
    previousBalance: bigint;
    staleReads: boolean;
    delivered: Map<string, bigint>;
    deliveries: number;
    burned: bigint;
    burnTxs: number;
    statuses: Map<string, "landed" | "failed" | "processed">;
    purchases: Map<string, bigint>;
    unreadable: Set<string>;
    counter: number;
    blockHeight: number;
    burnError: string | null;
    burnConfirmationLost: boolean;
    /** The next delivery lands, but the answer is lost and the node says "processed" for a while. */
    deliveryAnswerLost: boolean;
    /**
     * The next delivery is signed, lands, and the process dies before hearing
     * back. The state file as it stood at that moment is copied to `crashSnapshot`.
     */
    crashAfterSigning: boolean;
    stateFile: string;
    crashSnapshot: string;
    txs: WeakMap<Transaction, Array<{ wallet: PublicKey; amount: bigint }>>;
}

const mockChain: MockChain = freshChain();

function freshChain(): MockChain {
    return {
        keeper: "",
        mint: "",
        balance: 0n,
        previousBalance: 0n,
        staleReads: false,
        delivered: new Map(),
        deliveries: 0,
        burned: 0n,
        burnTxs: 0,
        statuses: new Map(),
        purchases: new Map(),
        unreadable: new Set(),
        counter: 0,
        blockHeight: 1_000_000,
        burnError: null,
        burnConfirmationLost: false,
        deliveryAnswerLost: false,
        crashAfterSigning: false,
        stateFile: "",
        crashSnapshot: "",
        txs: new WeakMap(),
    };
}

function mockSetBalance(next: bigint): void {
    mockChain.previousBalance = mockChain.balance;
    mockChain.balance = next;
}

function mockStatus(signature: string) {
    const status = mockChain.statuses.get(signature);
    if (!status) {
        return { context: { slot: 1 }, value: null };
    }
    if (status === "processed") {
        return { context: { slot: 1 }, value: { confirmationStatus: "processed", err: null, slot: 1, confirmations: 0 } };
    }
    return {
        context: { slot: 1 },
        value: {
            confirmationStatus: "finalized",
            err: status === "failed" ? { InstructionError: [0, { Custom: 1 }] } : null,
            slot: 1,
            confirmations: null,
        },
    };
}

function mockBuild(recipients: Array<{ wallet: PublicKey; amount: bigint }>) {
    const tx = new Transaction();
    mockChain.txs.set(tx, recipients);
    return { tx, recipientAtas: [], deliveredAmounts: recipients.map((r) => r.amount) };
}

async function mockDeliver(
    tx: Transaction,
    onSigned?: (notice: { signature: string; lastValidBlockHeight: number }) => void
): Promise<string> {
    const signature = `send-${++mockChain.counter}`;
    onSigned?.({ signature, lastValidBlockHeight: 10 });
    const recipients = mockChain.txs.get(tx) ?? [];
    const total = recipients.reduce((sum, r) => sum + r.amount, 0n);
    if (total > mockChain.balance) {
        // What preflight answers for a transfer bigger than the account.
        throw new Error("Transaction simulation failed: Error processing Instruction 1: custom program error: 0x1");
    }
    mockSetBalance(mockChain.balance - total);
    for (const r of recipients) {
        const wallet = r.wallet.toBase58();
        mockChain.delivered.set(wallet, (mockChain.delivered.get(wallet) ?? 0n) + r.amount);
    }
    mockChain.deliveries += 1;
    mockChain.statuses.set(signature, "landed");
    if (mockChain.deliveryAnswerLost) {
        // A dropped connection on the way back: not a PostSendError, no signature in it.
        mockChain.deliveryAnswerLost = false;
        mockChain.statuses.set(signature, "processed");
        throw new Error("fetch failed");
    }
    if (mockChain.crashAfterSigning) {
        mockChain.crashAfterSigning = false;
        fs.copyFileSync(mockChain.stateFile, mockChain.crashSnapshot);
        throw new MockCrash();
    }
    return signature;
}

/** Stands for the process dying: whatever was written to the state stays, nothing else runs. */
class MockCrash extends Error {}

function mockSign(tx: Transaction) {
    const signature = `burn-${++mockChain.counter}`;
    return Object.assign(tx, { __signature: signature, context: { blockhash: "fake", lastValidBlockHeight: 10 } });
}

async function mockBurnSend(tx: Transaction & { __signature?: string }): Promise<string> {
    const signature = tx.__signature as string;
    const burn = tx.instructions.find((ix) => ix.data.length >= 10 && ix.data[0] === 15);
    if (!burn) {
        throw new Error("not a burn");
    }
    const amount = burn.data.readBigUInt64LE(1);
    if (mockChain.burnError) {
        throw new Error(
            `failed to send transaction: Transaction simulation failed: Error processing Instruction 0: custom program error: ${mockChain.burnError}`
        );
    }
    if (amount > mockChain.balance) {
        throw new Error("failed to send transaction: Transaction simulation failed: Error processing Instruction 0: custom program error: 0x1");
    }
    mockSetBalance(mockChain.balance - amount);
    mockChain.burned += amount;
    mockChain.burnTxs += 1;
    if (mockChain.burnConfirmationLost) {
        // It landed; we never heard. The node says "processed" for a while.
        mockChain.burnConfirmationLost = false;
        mockChain.statuses.set(signature, "processed");
        const { PostSendError } = jest.requireActual("../../../solana/transaction");
        throw new PostSendError("Transaction send/confirm failed: timeout", signature, undefined, 10);
    }
    mockChain.statuses.set(signature, "landed");
    return signature;
}

/** A node's `getTransaction` answer for a purchase, in the shape `jsonParsed` gives. */
function mockTransaction(signature: string): unknown {
    if (mockChain.unreadable.has(signature) || !mockChain.purchases.has(signature)) {
        return null;
    }
    const delta = mockChain.purchases.get(signature)!;
    return {
        meta: {
            err: null,
            preBalances: [2_000_000_000],
            postBalances: [1_900_000_000],
            preTokenBalances: [],
            postTokenBalances: [
                { accountIndex: 1, mint: mockChain.mint, owner: mockChain.keeper, uiTokenAmount: { amount: delta.toString(), decimals: 6 } },
            ],
        },
        transaction: { message: { accountKeys: [{ pubkey: mockChain.keeper, signer: true, writable: true, source: "transaction" }] } },
        version: "legacy",
    };
}

jest.mock("../../../solana/connection", () => ({
    connection: {
        getTokenAccountBalance: jest.fn(async () => ({
            value: { amount: String(mockChain.staleReads ? mockChain.previousBalance : mockChain.balance) },
        })),
        getAccountInfo: jest.fn(async () => null),
        getSignatureStatus: jest.fn(async (signature: string) => mockStatus(signature)),
        getBlockHeight: jest.fn(async () => mockChain.blockHeight),
    },
    sendTxLimiter: { acquire: jest.fn(async () => undefined) },
}));

jest.mock("../../../solana/transaction", () => {
    const actual = jest.requireActual("../../../solana/transaction");
    return {
        ...actual,
        sendTransaction: jest.fn((tx, _keeper, onSigned) => mockDeliver(tx, onSigned)),
        signTransaction: jest.fn(async (tx) => mockSign(tx)),
        getSignedTransactionSignature: jest.fn((tx) => tx.__signature),
        sendSignedTransaction: jest.fn((tx) => mockBurnSend(tx)),
    };
});

jest.mock("../../../solana/priorityFee", () => ({
    ...jest.requireActual("../../../solana/priorityFee"),
    budgetInstructions: jest.fn(async () => []),
}));

jest.mock("../../../orchestrator/batchTransfer", () => {
    const { PublicKey: Key } = jest.requireActual("@solana/web3.js");
    const program = new Key("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
    return {
        detectTokenProgram: jest.fn(async () => program),
        getMintDecimals: jest.fn(async () => 6),
        buildBatchSendTransaction: jest.fn(async (_mint, recipients) => mockBuild(recipients)),
    };
});

import { readBatchFile } from "../../../orchestrator/batchFile";
import { executeSendRounds, generateSendRecords } from "../../../orchestrator/sendRounds";
import { finishBurns, settleAfterBuying } from "../../../orchestrator/settle";
import { burnOwed, sharesOf } from "../../../orchestrator/shares";
import { planResume, readLotteryState } from "../../../orchestrator/resume";
import { OrchestratorStateManager } from "../../../orchestrator/state";
import { LotteryState, RecipientStake } from "../../../orchestrator/types";
import { BatchState, PurchaseRecord } from "../../../scheduler/types";

const quiet = pino({ level: "silent" });

const realFetch = global.fetch;
beforeAll(() => {
    global.fetch = jest.fn(async (_url: unknown, init?: { body?: unknown }) => {
        const body = JSON.parse(String(init?.body)) as Array<{ id: number; params: [string] }>;
        return {
            ok: true,
            status: 200,
            json: async () => body.map((request) => ({ jsonrpc: "2.0", id: request.id, result: mockTransaction(request.params[0]) })),
        };
    }) as unknown as typeof fetch;
});
afterAll(() => {
    global.fetch = realFetch;
});

// =============================================================================
// THE HARNESS
// =============================================================================

interface Backer {
    wallet: string;
    sol: number;
    bps: number;
}

interface Purchase {
    /** When it lands: 0..1 is the buying window, from 0.95 on it comes after the last round. */
    t: number;
    raw: bigint;
}

interface RoundOptions {
    /** "old": the buyer is told nobody burns, and the burn is done beside it. */
    mode?: "new" | "old";
    /** A node one transaction behind on every balance read: during the rounds only, or to the end. */
    staleReads?: "rounds" | "always";
    spentSol?: number;
    /** Called before each delivery round with its number, to break the chain on purpose. */
    beforeRound?: (round: number) => void;
    /** Skip the settlement after the buying: the code as it was before round 1790348400190. */
    withoutSettlement?: boolean;
}

interface Outcome {
    bought: bigint;
    burned: bigint;
    delivered: Map<string, bigint>;
    left: bigint;
    state: LotteryState;
    burnsWaiting: string[];
}

const ROUNDS = 10;

async function runRound(backers: Backer[], purchases: Purchase[], options: RoundOptions = {}): Promise<Outcome> {
    const mode = options.mode ?? "new";
    Object.assign(mockChain, freshChain());
    const keeper = Keypair.generate();
    const mint = Keypair.generate().publicKey;
    mockChain.keeper = keeper.publicKey.toBase58();
    mockChain.mint = mint.toBase58();
    mockChain.staleReads = options.staleReads !== undefined;

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "burn-delivery-"));
    const batchFile = path.join(dir, "batch.json");
    const batch: BatchState = {
        runId: "run",
        mint: mint.toBase58(),
        totalSolAmount: 1,
        purchaseCount: purchases.length,
        config: {} as BatchState["config"],
        purchases: [],
        summary: { completedPurchases: 0, abandonedPurchases: 0, totalSolSpent: 0, startedAt: 1 },
    } as unknown as BatchState;
    fs.writeFileSync(batchFile, JSON.stringify(batch));

    const stakes: RecipientStake[] = backers.map((b) => {
        const lamports = BigInt(Math.round(b.sol * 1e9));
        const bps = mode === "new" ? b.bps : 0;
        return { wallet: b.wallet, stakeLamports: lamports.toString(), burnBps: bps, burnWeight: (lamports * BigInt(bps)).toString() };
    });
    // Nobody who burns everything gets a delivery record: the orchestrator's own filter.
    const deliveryRecipients = backers
        .filter((b) => b.bps < 10_000)
        .map((b) => ({ publickey: new PublicKey(b.wallet), amount: b.sol }));
    const sends = generateSendRecords([{ mint, recipients: deliveryRecipients }], ROUNDS);

    const state: LotteryState = {
        lotteryId: "harness",
        totalSol: 1,
        sendReserve: 0,
        buyBudget: 1,
        config: { buyConcurrency: 1, sendConcurrency: 1, buyWindowMinutes: 50, sendRounds: ROUNDS },
        tokenBuys: [{
            mint: mint.toBase58(),
            adjustedSolAmount: 1,
            status: "in_progress",
            batchStateFile: batchFile,
            recipients: stakes,
            spentSol: options.spentSol,
            updatedAt: 1,
        }],
        sends,
        summary: {
            tokensBought: 0, tokensFailed: 0, sendsTotal: sends.length, sendsCompleted: 0,
            sendsSatisfied: 0, sendsAbandoned: 0, sendsAtaMismatch: 0, startedAt: 1,
        },
    };
    const stateManager = OrchestratorStateManager.create(state, path.join(dir, "state.json"));

    // The real shares, for the burn done beside the buyer in the old mode.
    const realShares = sharesOf({
        ...state,
        tokenBuys: [{
            ...state.tokenBuys[0],
            recipients: backers.map((b) => {
                const lamports = BigInt(Math.round(b.sol * 1e9));
                return { wallet: b.wallet, stakeLamports: lamports.toString(), burnBps: b.bps, burnWeight: (lamports * BigInt(b.bps)).toString() };
            }),
        }],
    }, mint.toBase58());

    let bought = 0n;
    const queue = [...purchases].sort((a, b) => a.t - b.t);
    const land = (upTo: number) => {
        while (queue.length > 0 && queue[0].t < upTo) {
            const purchase = queue.shift()!;
            const signature = `buy-${++mockChain.counter}`;
            mockChain.purchases.set(signature, purchase.raw);
            mockSetBalance(mockChain.balance + purchase.raw);
            bought += purchase.raw;
            const current = JSON.parse(fs.readFileSync(batchFile, "utf-8")) as BatchState;
            const record: PurchaseRecord = {
                id: signature, index: current.purchases.length + 1, scheduledAt: 1, solAmount: 0.1,
                status: "completed", signature, attempts: 1, updatedAt: Date.now(),
            } as PurchaseRecord;
            current.purchases.push(record);
            fs.writeFileSync(batchFile, JSON.stringify(current));
        }
        if (mode === "old") {
            const due = burnOwed(bought, realShares) - mockChain.burned;
            const amount = due < mockChain.balance ? due : mockChain.balance;
            if (amount > 0n) {
                mockSetBalance(mockChain.balance - amount);
                mockChain.burned += amount;
            }
        }
    };

    let round = 0;
    const sleepFn = async () => {
        round += 1;
        land((round - 0.5) / ROUNDS);
        options.beforeRound?.(round);
    };

    await executeSendRounds({
        keeper, stateManager, totalRounds: ROUNDS, intervalMs: 600_000,
        sendConcurrency: 1, startTime: Date.now(), sleepFn, logger: quiet,
    });
    // The second pass: whatever lands after the last round.
    land(Number.POSITIVE_INFINITY);
    if (options.staleReads === "rounds") {
        mockChain.staleReads = false;
    }

    const settled = options.withoutSettlement
        ? { topUps: 0, burnsWaiting: [] as string[] }
        : await settleAfterBuying({
            stateManager, keeper, sendRounds: ROUNDS, loadBatch: readBatchFile,
            tokenBalance: async () => (mockChain.staleReads ? mockChain.previousBalance : mockChain.balance),
            sleepFn: async () => undefined, logger: quiet,
        });
    await executeSendRounds({
        keeper, stateManager, totalRounds: 1, intervalMs: 0, sendConcurrency: 1,
        startTime: Date.now() - 1, isSweep: true, logger: quiet,
    });
    const waiting = await finishBurns({
        stateManager, keeper, mints: settled.burnsWaiting, loadBatch: readBatchFile,
        sleepFn: async () => undefined, logger: quiet,
    });

    fs.rmSync(dir, { recursive: true, force: true });
    return {
        bought,
        burned: mockChain.burned,
        delivered: new Map(mockChain.delivered),
        left: mockChain.balance,
        state: stateManager.getState(),
        burnsWaiting: waiting,
    };
}

/** What the promise says each wallet gets and the fire gets. */
function promised(backers: Backer[], bought: bigint) {
    const stake = (b: Backer) => BigInt(Math.round(b.sol * 1e9));
    const denominator = backers.reduce((sum, b) => sum + stake(b), 0n) * 10_000n;
    const perWallet = new Map<string, bigint>();
    for (const b of backers) {
        perWallet.set(b.wallet, (perWallet.get(b.wallet) ?? 0n) + stake(b) * BigInt(10_000 - b.bps));
    }
    const owed = new Map<string, bigint>();
    for (const [wallet, weight] of perWallet) {
        owed.set(wallet, (bought * weight) / denominator);
    }
    const burnWeight = backers.reduce((sum, b) => sum + stake(b) * BigInt(b.bps), 0n);
    return { owed, burn: (bought * burnWeight) / denominator };
}

/** Deterministic randomness: a failing trial can be run again. */
function mulberry32(seed: number) {
    return () => {
        seed |= 0;
        seed = (seed + 0x6d2b79f5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function randomTrial(random: () => number): { backers: Backer[]; purchases: Purchase[] } {
    const pick = <T>(items: T[]) => items[Math.floor(random() * items.length)];
    const n = 1 + Math.floor(random() * 12);
    const backers: Backer[] = [];
    for (let i = 0; i < n; i++) {
        backers.push({
            wallet: Keypair.generate().publicKey.toBase58(),
            sol: pick([0.05, 0.1, 0.5, 1, 2, 5, 10, 25, 50]),
            bps: pick([0, 0, 2500, 5000, 7500, 10_000]),
        });
    }
    const k = 1 + Math.floor(random() * 40);
    const purchases: Purchase[] = [];
    for (let i = 0; i < k; i++) {
        // One in eight lands after the last round, like a second pass does.
        const late = random() < 0.125;
        purchases.push({
            t: late ? 0.96 + random() * 0.04 : random() * 0.95,
            raw: BigInt(1_000_000_000 + Math.floor(random() * 99_000_000_000_000)),
        });
    }
    return { backers, purchases };
}

/** Whether a finished round kept the promise, within the dust rounding leaves. */
function kept(backers: Backer[], outcome: Outcome): boolean {
    const { owed, burn } = promised(backers, outcome.bought);
    const slack = BigInt(2 + backers.length);
    for (const [wallet, want] of owed) {
        const got = outcome.delivered.get(wallet) ?? 0n;
        const gap = got > want ? got - want : want - got;
        if (gap > slack) {
            return false;
        }
    }
    const burnGap = outcome.burned > burn ? outcome.burned - burn : burn - outcome.burned;
    return burnGap <= 2n;
}

// =============================================================================
// THE TESTS
// =============================================================================

describe("burn and delivery, end to end on a fake chain", () => {
    it("keeps the promise to the raw unit in 400 random rounds, late purchases included", async () => {
        const random = mulberry32(7);
        let broken = 0;
        let exactMisses = 0;
        let maxDust = 0n;
        for (let trial = 0; trial < 400; trial++) {
            const { backers, purchases } = randomTrial(random);
            const outcome = await runRound(backers, purchases);
            if (!kept(backers, outcome)) {
                broken += 1;
            }
            const { owed, burn } = promised(backers, outcome.bought);
            // Stronger than the slack above: every wallet gets exactly its floor,
            // the fire gets exactly its floor, and nothing is lost on the way.
            for (const [wallet, want] of owed) {
                if ((outcome.delivered.get(wallet) ?? 0n) !== want) {
                    exactMisses += 1;
                }
            }
            if (outcome.burned !== burn) {
                exactMisses += 1;
            }
            const deliveredTotal = [...outcome.delivered.values()].reduce((sum, v) => sum + v, 0n);
            expect(outcome.burned + deliveredTotal + outcome.left).toBe(outcome.bought);
            // A wallet that burns everything is never sent anything.
            for (const b of backers.filter((x) => x.bps === 10_000)) {
                if (!backers.some((x) => x.wallet === b.wallet && x.bps < 10_000)) {
                    expect(outcome.delivered.get(b.wallet) ?? 0n).toBe(0n);
                }
            }
            if (outcome.left > maxDust) {
                maxDust = outcome.left;
            }
        }
        expect(broken).toBe(0);
        expect(exactMisses).toBe(0);
        // Rounding dust only: at most one raw unit per wallet and one for the fire.
        expect(maxDust).toBeLessThanOrEqual(13n);
    }, 120_000);

    it("the same harness catches the old formula: it breaks the promise in most rounds", async () => {
        const random = mulberry32(7);
        let broken = 0;
        let withBurners = 0;
        for (let trial = 0; trial < 400; trial++) {
            const { backers, purchases } = randomTrial(random);
            const outcome = await runRound(backers, purchases, { mode: "old" });
            if (backers.some((b) => b.bps > 0) && backers.some((b) => b.bps < 10_000)) {
                withBurners += 1;
            }
            if (!kept(backers, outcome)) {
                broken += 1;
            }
        }
        // Printed so a regression in the checker itself shows up as a number.
        console.log(`old formula: ${broken} of 400 rounds broke the promise (${withBurners} had burners and receivers)`);
        expect(broken).toBeGreaterThan(withBurners / 2);
    }, 120_000);

    it("without the settlement, what lands after the last round is stranded", async () => {
        // Round 1790348400190 in miniature: every delivery done by round 10, one
        // more purchase in the second pass. The sweep alone never sees it.
        const a = Keypair.generate().publicKey.toBase58();
        const b = Keypair.generate().publicKey.toBase58();
        const backers = [{ wallet: a, sol: 10, bps: 0 }, { wallet: b, sol: 0.45, bps: 0 }];
        const purchases = [{ t: 0.1, raw: 100_000_000n }, { t: 0.98, raw: 10_000_000n }];

        const before = await runRound(backers, purchases, { withoutSettlement: true });
        expect(before.left).toBeGreaterThanOrEqual(10_000_000n - 1n);
        expect(kept(backers, before)).toBe(false);

        const after = await runRound(backers, purchases);
        expect(kept(backers, after)).toBe(true);
        expect(after.left).toBeLessThanOrEqual(2n);
    });

    it("50% burn is exactly half of my share, whatever my friend chose", async () => {
        const me = Keypair.generate().publicKey.toBase58();
        const friend = Keypair.generate().publicKey.toBase58();
        const purchases: Purchase[] = [
            { t: 0.2, raw: 50_000_000_000_000n },
            { t: 0.7, raw: 50_000_000_000_000n },
        ];
        for (const friendBps of [0, 5000, 10_000]) {
            const outcome = await runRound(
                [{ wallet: me, sol: 10, bps: 5000 }, { wallet: friend, sol: 10, bps: friendBps }],
                purchases
            );
            // My share is half of everything; half of that is mine to keep.
            expect(outcome.delivered.get(me)).toBe(25_000_000_000_000n);
            expect(outcome.delivered.get(friend) ?? 0n).toBe((50_000_000_000_000n * BigInt(10_000 - friendBps)) / 10_000n);
            expect(outcome.burned).toBe(25_000_000_000_000n + (50_000_000_000_000n * BigInt(friendBps)) / 10_000n);
        }
    });

    it("a coin where everyone burns everything is visited, burned whole, and nobody is sent a thing", async () => {
        const a = Keypair.generate().publicKey.toBase58();
        const b = Keypair.generate().publicKey.toBase58();
        const outcome = await runRound(
            [{ wallet: a, sol: 3, bps: 10_000 }, { wallet: b, sol: 1, bps: 10_000 }],
            [{ t: 0.1, raw: 7_000_000n }, { t: 0.5, raw: 11_000_000n }, { t: 0.99, raw: 13_000_000n }]
        );
        expect(outcome.state.sends).toHaveLength(0);
        expect(mockChain.deliveries).toBe(0);
        expect(outcome.burned).toBe(31_000_000n);
        expect(outcome.left).toBe(0n);
    });

    it("a node one transaction behind never makes anyone get, or the fire take, more than promised", async () => {
        const random = mulberry32(99);
        for (let trial = 0; trial < 30; trial++) {
            const { backers, purchases } = randomTrial(random);
            const outcome = await runRound(backers, purchases, { staleReads: "always" });
            const { owed, burn } = promised(backers, outcome.bought);
            expect(outcome.burned).toBeLessThanOrEqual(burn);
            for (const [wallet, want] of owed) {
                expect(outcome.delivered.get(wallet) ?? 0n).toBeLessThanOrEqual(want);
            }
        }
    }, 60_000);

    it("once the node catches up, the settlement makes good whatever the stale rounds held back", async () => {
        const random = mulberry32(101);
        for (let trial = 0; trial < 30; trial++) {
            const { backers, purchases } = randomTrial(random);
            const outcome = await runRound(backers, purchases, { staleReads: "rounds" });
            const { owed, burn } = promised(backers, outcome.bought);
            expect(outcome.burned).toBe(burn);
            for (const [wallet, want] of owed) {
                expect(outcome.delivered.get(wallet) ?? 0n).toBe(want);
            }
        }
    }, 60_000);

    it("a burn the mint's authority can lift is retried, then blocked, and its share is never delivered", async () => {
        const keep = Keypair.generate().publicKey.toBase58();
        const burner = Keypair.generate().publicKey.toBase58();
        const outcome = await runRound(
            [{ wallet: keep, sol: 5, bps: 0 }, { wallet: burner, sol: 5, bps: 5000 }],
            [{ t: 0.1, raw: 40_000_000n }, { t: 0.6, raw: 60_000_000n }],
            { beforeRound: () => { mockChain.burnError = "0x43"; } }
        );
        const token = outcome.state.tokenBuys[0];
        expect(token.burnBlocked?.reason).toMatch(/paused/);
        expect(outcome.burned).toBe(0n);
        // Each gets their own share; the burner's burned half stays on the keeper.
        expect(outcome.delivered.get(keep)).toBe(50_000_000n);
        expect(outcome.delivered.get(burner)).toBe(25_000_000n);
        expect(outcome.left).toBe(25_000_000n);
        // Every round tried and was refused; nothing went out as a burn.
        expect((outcome.state.burns ?? []).every((burn) => burn.status === "failed")).toBe(true);
    });

    it("a structural refusal blocks the burn at once", async () => {
        const a = Keypair.generate().publicKey.toBase58();
        const outcome = await runRound(
            [{ wallet: a, sol: 1, bps: 2500 }],
            [{ t: 0.1, raw: 1_000_000n }],
            { beforeRound: () => { mockChain.burnError = "0x41"; } }
        );
        expect(outcome.state.tokenBuys[0].burnBlocked?.reason).toMatch(/ConfidentialMintBurn/);
        // One refusal, then nobody asks again.
        expect(outcome.state.burns).toHaveLength(1);
        expect(outcome.delivered.get(a)).toBe(750_000n);
        expect(outcome.left).toBe(250_000n);
    });

    it("a burn whose confirmation was lost is never sent again while its fate is unknown", async () => {
        const a = Keypair.generate().publicKey.toBase58();
        const b = Keypair.generate().publicKey.toBase58();
        let lostSignature = "";
        const outcome = await runRound(
            [{ wallet: a, sol: 1, bps: 10_000 }, { wallet: b, sol: 1, bps: 0 }],
            [{ t: 0.01, raw: 10_000_000n }, { t: 0.5, raw: 10_000_000n }],
            {
                beforeRound: (round) => {
                    if (round === 1) {
                        // The first burn lands but the answer never comes, and
                        // the chain is still inside that blockhash's lifetime.
                        mockChain.burnConfirmationLost = true;
                        mockChain.blockHeight = 5;
                    }
                    if (round === 2) {
                        lostSignature = [...mockChain.statuses.entries()].find(([, s]) => s === "processed")?.[0] ?? "";
                    }
                    if (round === 4) {
                        // Now the chain has it, and the blockhash is long gone.
                        mockChain.statuses.set(lostSignature, "landed");
                        mockChain.blockHeight = 1_000_000;
                    }
                },
            }
        );
        expect(lostSignature).not.toBe("");
        // Rounds 2 and 3 saw an unknown fate and burned nothing: the first burn
        // counted once, the second purchase's half burned once, nothing twice.
        expect(outcome.burned).toBe(10_000_000n);
        expect(outcome.delivered.get(b)).toBe(10_000_000n);
        expect(outcome.left).toBe(0n);
        const burns = outcome.state.burns ?? [];
        expect(burns.filter((burn) => burn.status === "completed").map((burn) => burn.rawAmount).sort())
            .toEqual(["5000000", "5000000"]);
    });

    it("a purchase the node cannot return yet is left out of B until it can", async () => {
        const a = Keypair.generate().publicKey.toBase58();
        const b = Keypair.generate().publicKey.toBase58();
        const outcome = await runRound(
            [{ wallet: a, sol: 1, bps: 5000 }, { wallet: b, sol: 1, bps: 0 }],
            [{ t: 0.01, raw: 8_000_000n }, { t: 0.3, raw: 12_000_000n }],
            {
                beforeRound: (round) => {
                    const second = [...mockChain.purchases.keys()][1];
                    if (round >= 4 && round < 8 && second) {
                        mockChain.unreadable.add(second);
                    }
                    if (round === 8) {
                        mockChain.unreadable.clear();
                    }
                },
            }
        );
        expect(outcome.burned).toBe(5_000_000n);
        expect(outcome.delivered.get(a)).toBe(5_000_000n);
        expect(outcome.delivered.get(b)).toBe(10_000_000n);
        expect(outcome.left).toBe(0n);
    });
});

// =============================================================================
// ROUND 1790348400190, REPLAYED
// =============================================================================
//
// Mainnet, 2026-09-25: one coin, two backers, 29 purchases. Purchase #28 expired
// on its first try, was bought again in the second pass at 17:11:23 and landed
// after the last delivery round (17:10:10). All six deliveries were done by
// then, so nothing picked its 10,532,688,345,348 raw up. They were sent by hand
// on 2026-09-28.
//
// The token deltas are what each purchase's own transaction put on the keeper,
// read back with `getTransaction` from two nodes (Helius and the public one) on
// 2026-09-28; they add up to 172,071,643,480,364. The first try of #28 is not on
// chain at all. The deliveries are the ones the round's state file recorded.

const REPLAY_BIG = "PrpNxdeSX8SwyUNv4H2pA7aZ6PRYzfAyEPPogCgCDnQ";
const REPLAY_SMALL = "BBAhmonxcKEWaxC5rwDXTLTknS8mqfSPn6asAPaqWpGb";

/** [purchase index, raw tokens it brought, when its record last changed]. */
const REPLAY_PURCHASES: Array<[number, bigint, number]> = [
    [1, 3878138814783n, 1790353301999],
    [2, 3215260623438n, 1790353328937],
    [3, 3668518053694n, 1790353452116],
    [4, 3211194934550n, 1790353613943],
    [5, 3313261421369n, 1790353718730],
    [6, 3026138188790n, 1790353758906],
    [7, 3337201447703n, 1790353835485],
    [8, 3125957683676n, 1790353956969],
    [9, 3533856083328n, 1790354110496],
    [10, 3212725055098n, 1790354227642],
    [11, 2988953721850n, 1790354265367],
    [12, 3081322931701n, 1790354380695],
    [13, 3011459871697n, 1790354544135],
    [14, 3216302905243n, 1790354654800],
    [15, 2915026613097n, 1790354729707],
    [16, 3195654900650n, 1790354825406],
    [17, 3159007515607n, 1790354878929],
    [18, 2828413753822n, 1790355022966],
    [19, 3648367442859n, 1790355144830],
    [20, 12327812211970n, 1790355228599],
    [21, 10530579976079n, 1790355337620],
    [22, 12017715862872n, 1790355460811],
    [23, 11534731955043n, 1790355498043],
    [24, 10396401553484n, 1790355685905],
    [25, 11518876975420n, 1790355721967],
    [26, 10693662328961n, 1790355841148],
    [27, 10631127070453n, 1790355956526],
    [28, 10532688345348n, 1790356284165],
    [29, 10321285237779n, 1790356193307],
];

/** [recipient, round, raw delivered, signature] as the state file has them. */
const REPLAY_SENDS: Array<[string, number, bigint, string]> = [
    [REPLAY_BIG, 2, 19437810561362n, "send-a"],
    [REPLAY_BIG, 4, 18449776960149n, "send-b"],
    [REPLAY_BIG, 6, 14830097422291n, "send-c"],
    [REPLAY_BIG, 8, 50610163830283n, "send-d"],
    [REPLAY_BIG, 10, 51254883412533n, "send-e"],
    [REPLAY_SMALL, 10, 6956222948397n, "send-e"],
];

async function replayRound(options: { withoutSettlement?: boolean; smallBurnsAll?: boolean } = {}) {
    Object.assign(mockChain, freshChain());
    const keeper = Keypair.generate();
    const mint = "56AsKxgMEVXcXSdqgzHHcPGJ7owdJwzfd9GyRvh8pump";
    mockChain.keeper = keeper.publicKey.toBase58();
    mockChain.mint = mint;

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "replay-"));
    const batchFile = path.join(dir, "batch.json");
    const purchases = REPLAY_PURCHASES.map(([index, raw, updatedAt]) => {
        const signature = `buy-${index}`;
        mockChain.purchases.set(signature, raw);
        return {
            id: signature, index, scheduledAt: updatedAt, solAmount: 0.35, status: "completed",
            signature, attempts: 1, updatedAt,
            // The first try of #28, which never reached the chain.
            ...(index === 28 ? { pendingSignature: "buy-28-first-try" } : {}),
        };
    });
    fs.writeFileSync(batchFile, JSON.stringify({
        runId: "batch_2026-09-25T16-20-10_byggrz", mint, totalSolAmount: 10.13236, purchaseCount: 29,
        config: {}, purchases,
        summary: { completedPurchases: 29, abandonedPurchases: 0, totalSolSpent: 10.12423, startedAt: 1790353210625, finishedAt: 1790356300000 },
    }));

    const bought = REPLAY_PURCHASES.reduce((sum, [, raw]) => sum + raw, 0n);
    const sent = REPLAY_SENDS.reduce((sum, [, , raw]) => sum + raw, 0n);
    mockChain.balance = bought - sent;
    mockChain.previousBalance = mockChain.balance;
    for (const [wallet, , raw] of REPLAY_SENDS) {
        mockChain.delivered.set(wallet, (mockChain.delivered.get(wallet) ?? 0n) + raw);
    }
    for (const [, , , signature] of REPLAY_SENDS) {
        mockChain.statuses.set(signature, "landed");
    }

    const state: LotteryState = {
        lotteryId: "1790348400190",
        totalSol: 10.13236,
        sendReserve: 0.00414,
        buyBudget: 10.12822,
        config: { buyConcurrency: 50, sendConcurrency: 20, buyWindowMinutes: 50, sendRounds: 10 },
        tokenBuys: [{
            mint,
            adjustedSolAmount: 10.13236,
            status: "completed",
            batchStateFile: batchFile,
            spentSol: 10.12423,
            recipients: [
                { wallet: REPLAY_BIG, stakeLamports: "10000000000", burnBps: 0, burnWeight: "0" },
                {
                    wallet: REPLAY_SMALL, stakeLamports: "450000000",
                    burnBps: options.smallBurnsAll ? 10_000 : 0,
                    burnWeight: options.smallBurnsAll ? "4500000000000" : "0",
                },
            ],
            updatedAt: 1790356300000,
        }],
        sends: REPLAY_SENDS.map(([recipient, round, raw, signature], i) => ({
            id: `send_${i + 1}`, mint, recipient,
            recipientBetSol: recipient === REPLAY_BIG ? 10 : 0.45,
            share: recipient === REPLAY_BIG ? 10 / 10.45 : 0.45 / 10.45,
            sendN: recipient === REPLAY_BIG ? 5 : 1,
            round, amount: raw.toString(), status: "completed", signature,
            // As the state file has it: neither wallet held the coin at the start.
            attempts: 1, hadAtaAtStart: false, updatedAt: 1790356211172,
        })),
        summary: {
            tokensBought: 1, tokensFailed: 0, sendsTotal: 6, sendsCompleted: 6,
            sendsSatisfied: 0, sendsAbandoned: 0, sendsAtaMismatch: 0, startedAt: 1790353210625,
        },
    };
    const stateManager = OrchestratorStateManager.create(state, path.join(dir, "state.json"));

    const settled = options.withoutSettlement
        ? { topUps: 0, burnsWaiting: [] as string[] }
        : await settleAfterBuying({
            stateManager, keeper, sendRounds: 10, loadBatch: readBatchFile,
            tokenBalance: async () => mockChain.balance, sleepFn: async () => undefined, logger: quiet,
        });
    await executeSendRounds({
        keeper, stateManager, totalRounds: 1, intervalMs: 0, sendConcurrency: 20,
        startTime: Date.now() - 1, isSweep: true, logger: quiet,
    });
    await finishBurns({ stateManager, keeper, mints: settled.burnsWaiting, loadBatch: readBatchFile, sleepFn: async () => undefined, logger: quiet });

    const result = {
        bought,
        topUps: settled.topUps,
        big: (mockChain.delivered.get(REPLAY_BIG) ?? 0n) - REPLAY_SENDS.filter(([w]) => w === REPLAY_BIG).reduce((s, [, , r]) => s + r, 0n),
        small: (mockChain.delivered.get(REPLAY_SMALL) ?? 0n) - REPLAY_SENDS.filter(([w]) => w === REPLAY_SMALL).reduce((s, [, , r]) => s + r, 0n),
        left: mockChain.balance,
        burned: mockChain.burned,
        state: stateManager.getState(),
    };
    fs.rmSync(dir, { recursive: true, force: true });
    return result;
}

describe("round 1790348400190, replayed", () => {
    it("the purchases add up to what the chain says", () => {
        expect(REPLAY_PURCHASES.reduce((sum, [, raw]) => sum + raw, 0n)).toBe(172_071_643_480_364n);
    });

    it("the code as it was sends nothing more: purchase #28 stays on the keeper", async () => {
        const replay = await replayRound({ withoutSettlement: true });
        expect(replay.big).toBe(0n);
        expect(replay.small).toBe(0n);
        expect(replay.left).toBe(10_532_688_345_349n);
    });

    it("the settlement delivers exactly the shortfall, to both backers", async () => {
        const replay = await replayRound();
        expect(replay.topUps).toBe(2);
        expect(replay.big).toBe(10_079_127_603_204n);
        expect(replay.small).toBe(453_560_742_144n);
        // Rounding dust, one raw unit.
        expect(replay.left).toBe(1n);
        // Run again from the same state (a crash and a recovery): nothing twice.
        const topUps = replay.state.sends.filter((send) => send.topUp);
        expect(topUps).toHaveLength(2);
        expect(topUps.every((send) => send.status === "completed")).toBe(true);
    });

    it("the same round with the small backer burning everything: B comes from the 29 transactions", async () => {
        // Their deliveries are already made in this replay, which cannot happen
        // for a 100% burner; what matters here is B. It must be read from the
        // purchases, the expired first try of #28 must count as nothing, and
        // the burn must be exactly their share of all 29.
        const replay = await replayRound({ smallBurnsAll: true });
        const owed = (172_071_643_480_364n * 450_000_000n * 10_000n) / (10_450_000_000n * 10_000n);
        expect(replay.state.purchaseTokens?.["buy-28"]).toBe("10532688345348");
        expect(replay.state.purchaseTokens?.["buy-28-first-try"]).toBe("0");
        // The keeper holds less than that after the deliveries already made to
        // them, so the burn takes what is there: never more.
        expect(replay.burned).toBeLessThanOrEqual(owed);
        expect(replay.burned + replay.left).toBe(10_532_688_345_349n - replay.big);
    });
});


// =============================================================================
// DELIVERIES THAT WENT OUT WITHOUT AN ANSWER
// =============================================================================

describe("a delivery is never sent twice", () => {
    it("an answer lost on the way back is looked up, not repeated, however many records the wallet has", async () => {
        const big = Keypair.generate().publicKey.toBase58();
        const small = Keypair.generate().publicKey.toBase58();
        let lost = "";
        let snapshotAfterRound4 = -1n;
        const outcome = await runRound(
            // 25 SOL delivers every round, so the wallet has a record in each.
            [{ wallet: big, sol: 25, bps: 0 }, { wallet: small, sol: 0.5, bps: 0 }],
            [{ t: 0.01, raw: 30_000_000n }, { t: 0.33, raw: 30_000_000n }, { t: 0.61, raw: 30_000_000n }],
            {
                beforeRound: (round) => {
                    // Round 4 delivers the second purchase, and the answer is lost.
                    if (round === 4) {
                        mockChain.deliveryAnswerLost = true;
                        mockChain.blockHeight = 5;
                    }
                    if (round === 5) {
                        lost = [...mockChain.statuses.entries()].find(([, status]) => status === "processed")?.[0] ?? "";
                    }
                    // Round 7 brings a third purchase while that fate is still
                    // unknown: the wallet must get nothing until it is known.
                    if (round === 7) {
                        expect(mockChain.delivered.get(big)).toBe(snapshotAfterRound4);
                    }
                    if (round === 8) {
                        mockChain.statuses.set(lost, "landed");
                        mockChain.blockHeight = 1_000_000;
                    }
                    if (round === 5) {
                        snapshotAfterRound4 = mockChain.delivered.get(big) ?? 0n;
                    }
                },
            }
        );
        expect(lost).not.toBe("");
        const { owed } = promised([{ wallet: big, sol: 25, bps: 0 }, { wallet: small, sol: 0.5, bps: 0 }], outcome.bought);
        expect(outcome.delivered.get(big)).toBe(owed.get(big));
        expect(outcome.delivered.get(small)).toBe(owed.get(small));
        const record = outcome.state.sends.find((send) => send.signature === lost);
        expect(record?.status).toBe("completed");
    });

    it("the process dying while a delivery is confirmed: recovery finds its signature and does not send it again", async () => {
        Object.assign(mockChain, freshChain());
        const keeper = Keypair.generate();
        const mint = Keypair.generate().publicKey;
        const wallet = Keypair.generate().publicKey;
        mockChain.keeper = keeper.publicKey.toBase58();
        mockChain.mint = mint.toBase58();
        mockChain.balance = 1_000n;
        mockChain.previousBalance = 1_000n;

        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crash-"));
        mockChain.stateFile = path.join(dir, "state.json");
        mockChain.crashSnapshot = path.join(dir, "after-crash.json");
        const sends = generateSendRecords([{ mint, recipients: [{ publickey: wallet, amount: 1 }] }], 1);
        const state: LotteryState = {
            lotteryId: "crash", totalSol: 1, sendReserve: 0, buyBudget: 1,
            config: { buyConcurrency: 1, sendConcurrency: 1, buyWindowMinutes: 50, sendRounds: 1 },
            tokenBuys: [{ mint: mint.toBase58(), adjustedSolAmount: 1, status: "completed", updatedAt: 1 }],
            sends,
            summary: { tokensBought: 1, tokensFailed: 0, sendsTotal: 1, sendsCompleted: 0, sendsSatisfied: 0, sendsAbandoned: 0, sendsAtaMismatch: 0, startedAt: 1 },
        };
        const first = OrchestratorStateManager.create(state, mockChain.stateFile);

        mockChain.crashAfterSigning = true;
        await executeSendRounds({ keeper, stateManager: first, totalRounds: 1, intervalMs: 0, sendConcurrency: 1, startTime: Date.now() - 1, logger: quiet });
        expect(mockChain.delivered.get(wallet.toBase58())).toBe(1_000n);

        // What the disk held when the process died.
        const crashed = readLotteryState(mockChain.crashSnapshot)!;
        expect(crashed.sends[0].status).toBe("in_progress");
        expect(crashed.sends[0].pendingSignature).toMatch(/^send-/);

        // Recovery: the same steps `resumeLottery` takes before the sweep.
        const recovered = OrchestratorStateManager.create(crashed, path.join(dir, "recovered.json"));
        planResume(recovered, () => null);
        await executeSendRounds({ keeper, stateManager: recovered, totalRounds: 1, intervalMs: 0, sendConcurrency: 1, startTime: Date.now() - 1, isSweep: true, logger: quiet });

        expect(mockChain.deliveries).toBe(1);
        expect(mockChain.delivered.get(wallet.toBase58())).toBe(1_000n);
        expect(recovered.getState().sends[0].status).toBe("completed");
        fs.rmSync(dir, { recursive: true, force: true });
    });
});
