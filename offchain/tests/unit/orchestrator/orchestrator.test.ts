// tests/unit/orchestrator/orchestrator.test.ts

import { Keypair, PublicKey } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// =============================================================================
// MOCKS
// =============================================================================

jest.mock("../../../solana/connection", () => ({
    connection: {
        getAccountInfo: jest.fn(),
        getTokenAccountBalance: jest.fn(),
    },
}));

jest.mock("../../../solana/transaction", () => ({
    sendTransaction: jest.fn().mockResolvedValue("mock-send-sig"),
}));

jest.mock("../../../scheduler", () => ({
    batchBuy: jest.fn(),
}));

// Mock executeSendRounds to be instant (no real timers)
jest.mock("../../../orchestrator/sendRounds", () => {
    const actual = jest.requireActual("../../../orchestrator/sendRounds");
    return {
        ...actual,
        executeSendRounds: jest.fn().mockResolvedValue(undefined),
    };
});

jest.mock("@solana/spl-token", () => {
    const actual = jest.requireActual("@solana/spl-token");
    return {
        ...actual,
        getMint: jest.fn().mockResolvedValue({ decimals: 6, isInitialized: true }),
    };
});

import { executeLottery } from "../../../orchestrator/orchestrator";
import { batchBuy } from "../../../scheduler";
import { connection } from "../../../solana/connection";
import { executeSendRounds } from "../../../orchestrator/sendRounds";
import { LotteryState, ExecuteLotteryParams } from "../../../orchestrator/types";

const mockBatchBuy = batchBuy as jest.Mock;
const mockGetAccountInfo = connection.getAccountInfo as jest.Mock;
const mockExecuteSendRounds = executeSendRounds as jest.Mock;

// =============================================================================
// HELPERS
// =============================================================================

function tmpDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "lottery-test-"));
}

function makeParams(overrides?: Partial<ExecuteLotteryParams>): ExecuteLotteryParams {
    // The pauses between sweep passes are instant, or the test would wait 2.5 minutes
    const keeper = Keypair.generate();
    const mint1 = Keypair.generate().publicKey;
    const mint2 = Keypair.generate().publicKey;
    const r1 = Keypair.generate().publicKey;
    const r2 = Keypair.generate().publicKey;

    return {
        sleepFn: async () => undefined,
        lotteryId: "test-lottery-1",
        tokens: [
            {
                mint: mint1,
                totalSol: 5,
                recipients: [
                    { publickey: r1, amount: 0.05 },
                    { publickey: r2, amount: 0.1 },
                ],
            },
            {
                mint: mint2,
                totalSol: 5,
                recipients: [
                    { publickey: r1, amount: 0.05 },
                ],
            },
        ],
        keeper,
        buyConcurrency: 100,
        sendConcurrency: 20,
        buyWindowMinutes: 50,
        sendRounds: 2,
        stateFilePath: path.join(tmpDir(), "test-lottery.json"),
        ...overrides,
    };
}

// =============================================================================
// TESTS
// =============================================================================

describe("executeLottery", () => {
    beforeEach(() => {
        jest.clearAllMocks();

        // Mock batchBuy success
        mockBatchBuy.mockResolvedValue({
            runId: "batch_test",
            stateFilePath: "/tmp/batch.json",
            summary: {
                completedPurchases: 5,
                abandonedPurchases: 0,
                totalSolSpent: 4.9,
                startedAt: Date.now(),
                finishedAt: Date.now(),
            },
        });

        // Mock token program detection
        mockGetAccountInfo.mockResolvedValue({
            owner: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
            data: Buffer.alloc(82),
        });

        // Mock send rounds to resolve immediately
        mockExecuteSendRounds.mockResolvedValue(undefined);
    });

    it("should complete happy path with 2 tokens", async () => {
        const params = makeParams();
        const result = await executeLottery(params);

        expect(result.lotteryId).toBe("test-lottery-1");
        expect(result.summary.tokensBought).toBe(2);
        expect(result.summary.tokensFailed).toBe(0);

        // batchBuy should be called for each token
        expect(mockBatchBuy).toHaveBeenCalledTimes(2);
    });

    it("should deduct send reserve from buy budget", async () => {
        const params = makeParams();
        await executeLottery(params);

        // Check that batchBuy receives less than totalSol
        for (const call of mockBatchBuy.mock.calls) {
            expect(call[0].totalSolAmount).toBeLessThan(5);
        }
    });

    it("should handle partial buy failure", async () => {
        mockBatchBuy
            .mockResolvedValueOnce({
                runId: "batch_ok",
                stateFilePath: "/tmp/batch_ok.json",
                summary: {
                    completedPurchases: 5,
                    abandonedPurchases: 0,
                    totalSolSpent: 4.9,
                    startedAt: Date.now(),
                    finishedAt: Date.now(),
                },
            })
            .mockRejectedValueOnce(new Error("insufficient funds"));

        const params = makeParams();
        const result = await executeLottery(params);

        expect(result.summary.tokensBought).toBe(1);
        expect(result.summary.tokensFailed).toBe(1);
    });

    it("should persist state to file", async () => {
        const dir = tmpDir();
        const stateFile = path.join(dir, "state.json");
        const params = makeParams({ stateFilePath: stateFile });

        await executeLottery(params);

        expect(fs.existsSync(stateFile)).toBe(true);

        const state: LotteryState = JSON.parse(
            fs.readFileSync(stateFile, "utf-8")
        );

        expect(state.lotteryId).toBe("test-lottery-1");
        expect(state.summary.finishedAt).toBeDefined();
        expect(state.tokenBuys.length).toBe(2);
        expect(state.sends.length).toBeGreaterThan(0);
    });

    it("should create send records for all recipients", async () => {
        const dir = tmpDir();
        const stateFile = path.join(dir, "state.json");
        const params = makeParams({ stateFilePath: stateFile });

        await executeLottery(params);

        const state: LotteryState = JSON.parse(
            fs.readFileSync(stateFile, "utf-8")
        );

        // 3 recipients total (r1+r2 on token1, r1 on token2), each with sendN=1 (all ≤0.1 SOL)
        expect(state.sends.length).toBeGreaterThanOrEqual(3);
    });

    it("should set config in state", async () => {
        const dir = tmpDir();
        const stateFile = path.join(dir, "state.json");
        const params = makeParams({ stateFilePath: stateFile });

        await executeLottery(params);

        const state: LotteryState = JSON.parse(
            fs.readFileSync(stateFile, "utf-8")
        );

        expect(state.config.buyConcurrency).toBe(100);
        expect(state.config.sendConcurrency).toBe(20);
        expect(state.config.buyWindowMinutes).toBe(50);
        expect(state.config.sendRounds).toBe(2);
    });

    it("should call executeSendRounds with correct params", async () => {
        const params = makeParams();
        await executeLottery(params);

        // The main call plus the sweep (pending sends left over from the mock)
        expect(mockExecuteSendRounds).toHaveBeenCalledWith(
            expect.objectContaining({
                totalRounds: 2,
                sendConcurrency: 20,
                keeper: params.keeper,
            })
        );
        // The sweep call
        const sweepCall = mockExecuteSendRounds.mock.calls.find(
            (c: any[]) => c[0].isSweep === true
        );
        if (sweepCall) {
            expect(sweepCall[0].totalRounds).toBe(1);
            expect(sweepCall[0].isSweep).toBe(true);
        }
    });

    // On devnet on 2026-09-18 a round with 4.6 SOL failed exactly like this:
    // delivery hit a mint that is not on the network, the exception travelled
    // up, and the refund never happened — somebody else's SOL was left on the keeper.
    it("returns the SOL even when delivery failed with an exception", async () => {
        const params = makeParams();
        mockExecuteSendRounds.mockRejectedValue(
            new Error("Mint account not found: 47MnKCEMVquA4TBppHacYBk9EhHMpjVeWhixYMRDpump")
        );

        await expect(executeLottery(params)).rejects.toThrow("Mint account not found");

        const state: LotteryState = JSON.parse(
            fs.readFileSync(params.stateFilePath!, "utf-8")
        );
        expect(state.refunds?.length ?? 0).toBeGreaterThan(0);
        expect(state.summary.finishedAt).toBeTruthy();
    });
});

describe("sweep: every pass requeues what failed on the previous one", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockBatchBuy.mockResolvedValue({
            runId: "r", stateFilePath: "s",
            summary: { completedPurchases: 1, abandonedPurchases: 0, totalSolSpent: 1 },
        });
        mockGetAccountInfo.mockResolvedValue(null);
    });

    // A regression from the PR #28 review. The abandoned -> pending reset ran
    // ONCE before the loop. Inside executeSendRounds with totalRounds: 1 the
    // condition round < totalRounds is false, so a failed delivery became
    // abandoned again immediately, the next iteration found nothing in pending
    // and left on a break. The 30s/120s pauses never once ran — and the sweep
    // was added for exactly them (429, a blinking node).
    it("makes all three passes when deliveries keep failing", async () => {
        // The mock repeats what the real executeSendRounds does at totalRounds: 1
        mockExecuteSendRounds.mockImplementation(async ({ stateManager, isSweep }: any) => {
            if (!isSweep) return;
            for (const send of stateManager.getState().sends) {
                if (send.status === "pending") {
                    stateManager.updateSend(send.id, {
                        status: "abandoned",
                        errorMessage: "429 Too Many Requests",
                    });
                }
            }
        });

        await executeLottery(makeParams());

        const sweepCalls = mockExecuteSendRounds.mock.calls.filter(
            (c) => c[0]?.isSweep === true
        );
        expect(sweepCalls).toHaveLength(3);
    });

    it("does not revive deliveries that used up their attempts", async () => {
        // The deliveries fail and have already spent the attempt limit
        mockExecuteSendRounds.mockImplementation(async ({ stateManager, isSweep }: any) => {
            if (!isSweep) return;
            for (const send of stateManager.getState().sends) {
                if (send.status === "pending") {
                    stateManager.updateSend(send.id, {
                        status: "abandoned",
                        errorMessage: "429 Too Many Requests",
                        attempts: 3,
                    });
                }
            }
        });

        await executeLottery(makeParams());

        // The first pass happened, after that there is nothing to revive — the limit is respected
        const sweepCalls = mockExecuteSendRounds.mock.calls.filter(
            (c) => c[0]?.isSweep === true
        );
        expect(sweepCalls).toHaveLength(1);
    });
});
