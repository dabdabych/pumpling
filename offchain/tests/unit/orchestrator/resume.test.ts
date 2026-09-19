// tests/unit/orchestrator/resume.test.ts
// Resuming a round after the process died.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Keypair } from "@solana/web3.js";

import {
    MIN_RESUME_SOL,
    MIN_RESUME_WINDOW_MINUTES,
    findUnfinishedStates,
    isUnfinished,
    planResume,
    remainingWindowMinutes,
    spentInBatch,
} from "../../../orchestrator/resume";
import { OrchestratorStateManager } from "../../../orchestrator/state";
import { LotteryState } from "../../../orchestrator/types";
import { BatchState } from "../../../scheduler/types";

// =============================================================================
// HELPERS
// =============================================================================

function tmpDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "resume-test-"));
}

const MINT_A = Keypair.generate().publicKey.toBase58();
const MINT_B = Keypair.generate().publicKey.toBase58();

function makeState(overrides?: Partial<LotteryState>): LotteryState {
    return {
        lotteryId: "128",
        totalSol: 10,
        sendReserve: 1,
        buyBudget: 9,
        config: { buyConcurrency: 50, sendConcurrency: 20, buyWindowMinutes: 50, sendRounds: 10 },
        tokenBuys: [
            { mint: MINT_A, adjustedSolAmount: 6, status: "in_progress", batchStateFiles: ["batch-a.json"], updatedAt: 1 },
            { mint: MINT_B, adjustedSolAmount: 3, status: "pending", updatedAt: 1 },
        ],
        sends: [
            { id: "s1", mint: MINT_A, recipient: "r1", recipientBetSol: 1, share: 0.5, sendN: 1, round: 1, status: "in_progress", attempts: 1 },
            { id: "s2", mint: MINT_A, recipient: "r2", recipientBetSol: 1, share: 0.5, sendN: 1, round: 1, status: "completed", attempts: 1 },
            { id: "s3", mint: MINT_B, recipient: "r3", recipientBetSol: 1, share: 1, sendN: 1, round: 1, status: "pending", attempts: 0 },
        ],
        summary: {
            tokensBought: 0,
            tokensFailed: 0,
            sendsTotal: 3,
            sendsCompleted: 1,
            sendsSatisfied: 0,
            sendsAbandoned: 0,
            sendsAtaMismatch: 0,
            startedAt: Date.now(),
        },
        ...overrides,
    } as LotteryState;
}

function batchWith(completedSol: number[], pendingSol: number[] = []): BatchState {
    return {
        runId: "run-1",
        mint: MINT_A,
        totalSolAmount: completedSol.concat(pendingSol).reduce((a, b) => a + b, 0),
        purchaseCount: completedSol.length + pendingSol.length,
        config: {} as BatchState["config"],
        purchases: [
            ...completedSol.map((solAmount, index) => ({
                id: `c${index}`, index, scheduledAt: 0, solAmount, status: "completed" as const, signature: `sig${index}`, attempts: 1,
            })),
            ...pendingSol.map((solAmount, index) => ({
                id: `p${index}`, index: 100 + index, scheduledAt: 0, solAmount, status: "pending" as const, attempts: 0,
            })),
        ],
        summary: { completedPurchases: completedSol.length, abandonedPurchases: 0, totalSolSpent: 0, startedAt: 0 },
    } as unknown as BatchState;
}

function managerFor(state: LotteryState): OrchestratorStateManager {
    return OrchestratorStateManager.create(state, path.join(tmpDir(), "lottery_128.json"));
}

// =============================================================================
// TESTS
// =============================================================================

describe("finding unfinished rounds", () => {
    it("finds files with no finish time", () => {
        const dir = tmpDir();
        const unfinished = makeState();
        const finished = makeState({ lotteryId: "127" });
        finished.summary.finishedAt = Date.now();

        fs.writeFileSync(path.join(dir, "lottery_128.json"), JSON.stringify(unfinished));
        fs.writeFileSync(path.join(dir, "lottery_127.json"), JSON.stringify(finished));
        // Batch files live in the same folder: they must not be picked up.
        fs.writeFileSync(path.join(dir, "batch_128_abc_1.json"), JSON.stringify(batchWith([1])));

        const found = findUnfinishedStates(dir);

        expect(found).toHaveLength(1);
        expect(found[0]).toContain("lottery_128.json");
    });

    it("a half-written file does not break startup", () => {
        const dir = tmpDir();
        fs.writeFileSync(path.join(dir, "lottery_999.json"), "{ this is not json");

        expect(findUnfinishedStates(dir)).toEqual([]);
    });

    it("no folder, no work", () => {
        expect(findUnfinishedStates(path.join(tmpDir(), "no-such-folder"))).toEqual([]);
    });

    it("a closed round is left alone", () => {
        const finished = makeState();
        finished.summary.finishedAt = Date.now();

        expect(isUnfinished(finished)).toBe(false);
        expect(isUnfinished(makeState())).toBe(true);
    });
});

describe("how much has been spent", () => {
    it("counts only completed purchases", () => {
        expect(spentInBatch(batchWith([1.5, 2], [3]))).toBe(3.5);
    });

    it("an empty or missing batch is zero", () => {
        expect(spentInBatch(null)).toBe(0);
        expect(spentInBatch(batchWith([]))).toBe(0);
    });
});

describe("the plan for what is left to buy", () => {
    it("buys only the remainder", () => {
        const manager = managerFor(makeState());
        const plan = planResume(manager, () => batchWith([2, 1]));

        const forA = plan.buys.find((item) => item.mint.toBase58() === MINT_A);
        expect(forA?.solAmount).toBeCloseTo(3, 9); // was 6, bought 3
        const forB = plan.buys.find((item) => item.mint.toBase58() === MINT_B);
        expect(forB?.solAmount).toBe(3); // the coin was never started
    });

    it("does not chase dust", () => {
        const manager = managerFor(makeState());
        // Almost everything was bought for the first coin: the remainder is below the threshold.
        const plan = planResume(manager, (file) => (file === "batch-a.json" ? batchWith([6 - MIN_RESUME_SOL / 2]) : null));

        expect(plan.buys.map((item) => item.mint.toBase58())).toEqual([MINT_B]);
        expect(plan.settled).toEqual([MINT_A]);
        expect(manager.getTokenBuy(MINT_A)?.status).toBe("completed");
    });

    it("a coin with nothing bought and nothing to buy fails honestly", () => {
        const state = makeState();
        state.tokenBuys[0].adjustedSolAmount = MIN_RESUME_SOL / 2;
        const manager = managerFor(state);

        const plan = planResume(manager, () => null);

        expect(plan.buys.map((item) => item.mint.toBase58())).toEqual([MINT_B]);
        expect(manager.getTokenBuy(MINT_A)?.status).toBe("failed");
        expect(manager.getTokenBuy(MINT_A)?.errorMessage).toContain("Nothing bought");
    });

    it("leaves the bought and the failed alone", () => {
        const state = makeState();
        state.tokenBuys[0].status = "completed";
        state.tokenBuys[1].status = "failed";
        const manager = managerFor(state);

        const plan = planResume(manager, () => batchWith([1]));

        expect(plan.buys).toEqual([]);
    });

    it("what was spent is written into the state", () => {
        const manager = managerFor(makeState());
        planResume(manager, (file) => (file === "batch-a.json" ? batchWith([2, 1]) : null));

        expect(manager.getTokenBuy(MINT_A)?.spentSol).toBeCloseTo(3, 9);
    });

    it("counts every pass, not just the last one", () => {
        const state = makeState();
        state.tokenBuys[0].batchStateFiles = ["batch-a-1.json", "batch-a-2.json"];
        const manager = managerFor(state);

        const plan = planResume(manager, (file) =>
            file === "batch-a-1.json" ? batchWith([2]) : batchWith([1.5])
        );

        expect(plan.buys.find((item) => item.mint.toBase58() === MINT_A)?.solAmount).toBeCloseTo(2.5, 9);
    });

    it("stuck deliveries go back in the queue, the rest are untouched", () => {
        const manager = managerFor(makeState());
        const plan = planResume(manager, () => null);

        const sends = manager.getState().sends;
        expect(plan.revivedSends).toBe(1);
        expect(sends.find((s) => s.id === "s1")?.status).toBe("pending");
        expect(sends.find((s) => s.id === "s2")?.status).toBe("completed");
        expect(sends.find((s) => s.id === "s3")?.status).toBe("pending");
    });
});

describe("what is left of the buying window", () => {
    const state = makeState();

    it("is measured from the start of the round", () => {
        const startedAt = state.summary.startedAt;
        // Twenty minutes of fifty have passed.
        expect(remainingWindowMinutes(state, startedAt + 20 * 60_000)).toBe(30);
    });

    it("is never zero: there has to be some time to buy in", () => {
        const startedAt = state.summary.startedAt;
        expect(remainingWindowMinutes(state, startedAt + 5 * 60 * 60_000)).toBe(MIN_RESUME_WINDOW_MINUTES);
    });
});
