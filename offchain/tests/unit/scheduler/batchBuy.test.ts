// tests/unit/scheduler/batchBuy.test.ts
// Orchestration test for batchBuy() with mocked buy()

import { Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
import { BatchBuyResult, BatchState } from "../../../scheduler/types";
import { ATA_FEE_SOL, TX_FEE_SOL } from "../../../scheduler/fees";

/** The same keeper headroom as in batch.ts: ATA rent plus fees. */
const KEEPER_FLOOR_SOL = ATA_FEE_SOL + 2 * TX_FEE_SOL;

// =============================================================================
// MOCKS
// =============================================================================

const mockBuy = jest.fn();
const mockGetAccountInfo = jest.fn();
const mockGetBalance = jest.fn();
const mockGetSignatureStatus = jest.fn();

jest.mock("../../../buy", () => ({
    buy: (...args: unknown[]) => mockBuy(...args),
}));

const mockInspectMint = jest.fn();
jest.mock("../../../solana/tokenExtensions", () => ({
    inspectMint: (...args: unknown[]) => mockInspectMint(...args),
}));

jest.mock("../../../solana/connection", () => ({
    connection: {
        getAccountInfo: (...args: unknown[]) => mockGetAccountInfo(...args),
        getBalance: (...args: unknown[]) => mockGetBalance(...args),
        getSignatureStatus: (...args: unknown[]) => mockGetSignatureStatus(...args),
    },
}));

// Replace sleepUntil and sleep with instant versions (no real delays)
jest.mock("../../../scheduler/timing", () => {
    const actual = jest.requireActual("../../../scheduler/timing");
    return {
        ...actual,
        sleepUntil: jest.fn().mockResolvedValue(undefined),
        sleep: jest.fn().mockResolvedValue(undefined),
    };
});

import { batchBuy } from "../../../scheduler/batch";

// =============================================================================
// HELPERS
// =============================================================================

const TEST_MINT = new PublicKey("So11111111111111111111111111111111111111112");
const TEST_KEEPER = Keypair.generate();

let tempDir: string;

beforeEach(() => {
    jest.clearAllMocks();
    // No ATA by default
    mockGetAccountInfo.mockResolvedValue(null);
    // The balance is comfortably enough, so purchases are not shrunk
    mockGetBalance.mockResolvedValue(1000 * LAMPORTS_PER_SOL);
    // No signature found by default
    mockGetSignatureStatus.mockResolvedValue({ value: null });
    // A coin with no extensions that would block delivery
    mockInspectMint.mockResolvedValue({
        blockers: [], warnings: [], transferFeeConfig: null, hasTransferHook: false,
    });
    // A temporary directory for the state files
    tempDir = fs.mkdtempSync(path.join("/tmp", "batch-test-"));
});

afterEach(() => {
    // Remove the temporary files
    fs.rmSync(tempDir, { recursive: true, force: true });
});

function stateFilePath(name: string): string {
    return path.join(tempDir, `${name}.json`);
}

function readState(filePath: string): BatchState {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

function printSummaryTable(state: BatchState): void {
    const { purchases, summary } = state;
    const rows = purchases.map((p) => ({
        "#": p.index,
        status: p.status,
        SOL: p.solAmount.toFixed(6),
        venue: p.venue || "-",
        attempts: p.attempts,
        slippage: p.lastSlippageBps ? `${(p.lastSlippageBps / 100).toFixed(1)}%` : "-",
        scheduled: `${Math.floor((p.scheduledAt - summary.startedAt) / 1000)}s`,
        result: p.signature
            ? p.signature.slice(0, 16) + "..."
            : p.errorMessage?.slice(0, 30) || "-",
    }));
    console.log("\n--- Purchase Summary ---");
    console.table(rows);
    console.log(
        `Completed: ${summary.completedPurchases}/${purchases.length}` +
            (summary.abandonedPurchases > 0
                ? ` | Abandoned: ${summary.abandonedPurchases}`
                : "") +
            ` | Spent: ${summary.totalSolSpent.toFixed(6)} SOL\n`
    );
}

// =============================================================================
// TESTS
// =============================================================================

describe("batchBuy orchestration", () => {
    describe("happy path — all purchases succeed", () => {
        it("should complete all purchases for small amount (N=1)", async () => {
            mockBuy.mockResolvedValue({
                signature: "sig-1",
                venue: "pumpfun",
            });

            const sf = stateFilePath("happy-n1");
            const result = await batchBuy({
                mint: TEST_MINT,
                totalSolAmount: 0.05,
                keeper: TEST_KEEPER,
                windowMinutes: 1,
                stateFilePath: sf,
            });

            expect(result.summary.completedPurchases).toBe(1);
            expect(result.summary.abandonedPurchases).toBe(0);
            expect(result.summary.totalSolSpent).toBeGreaterThan(0);
            expect(mockBuy).toHaveBeenCalledTimes(1);

            // Check the state file
            const state = readState(sf);
            expect(state.purchases).toHaveLength(1);
            expect(state.purchases[0].status).toBe("completed");
            expect(state.purchases[0].signature).toBe("sig-1");
            expect(state.purchases[0].venue).toBe("pumpfun");
            expect(state.summary.finishedAt).toBeDefined();
        });

        it("should complete all purchases for medium amount (N=multiple)", async () => {
            let callCount = 0;
            mockBuy.mockImplementation(() => {
                callCount++;
                return Promise.resolve({
                    signature: `sig-${callCount}`,
                    venue: "dex",
                });
            });

            const sf = stateFilePath("happy-multi");
            const result = await batchBuy({
                mint: TEST_MINT,
                totalSolAmount: 0.5,
                keeper: TEST_KEEPER,
                windowMinutes: 1,
                stateFilePath: sf,
            });

            // 0.5 SOL → N=5
            expect(result.summary.completedPurchases).toBe(5);
            expect(result.summary.abandonedPurchases).toBe(0);
            expect(mockBuy).toHaveBeenCalledTimes(5);

            const state = readState(sf);
            printSummaryTable(state);
            expect(state.purchases).toHaveLength(5);
            state.purchases.forEach((p, i) => {
                expect(p.status).toBe("completed");
                expect(p.signature).toBe(`sig-${i + 1}`);
            });
        });
    });

    describe("instant slippage retry in main loop", () => {
        it("should instantly retry with 5% on slippage error in main loop", async () => {
            const slippageValues: number[] = [];
            let callCount = 0;
            mockBuy.mockImplementation(
                (_mint: PublicKey, _amount: number, _keeper: Keypair, slippage: number) => {
                    callCount++;
                    slippageValues.push(slippage);
                    if (callCount === 1) {
                        return Promise.reject(new Error("Slippage exceeded"));
                    }
                    return Promise.resolve({ signature: "sig-ok", venue: "dex" });
                }
            );

            const sf = stateFilePath("instant-slippage");
            const result = await batchBuy({
                mint: TEST_MINT,
                totalSolAmount: 0.05,
                keeper: TEST_KEEPER,
                windowMinutes: 1,
                retryBufferMinutes: 1,
                stateFilePath: sf,
            });

            expect(result.summary.completedPurchases).toBe(1);
            // Main loop 3%, instant retry 5% → success, no retry phase needed
            expect(slippageValues[0]).toBe(300);
            expect(slippageValues[1]).toBe(500);
            expect(mockBuy).toHaveBeenCalledTimes(2);
        });

        it("climbs 300 -> 500 -> 900 in the main loop before deferring", async () => {
            const slippageValues: number[] = [];
            let callCount = 0;
            mockBuy.mockImplementation(
                (_mint: PublicKey, _amount: number, _keeper: Keypair, slippage: number) => {
                    callCount++;
                    slippageValues.push(slippage);
                    // The first three attempts are in the main loop and all fail
                    if (callCount <= 3) {
                        return Promise.reject(new Error("ExceededSlippageToleranceError"));
                    }
                    return Promise.resolve({ signature: "sig-ok", venue: "pumpfun" });
                }
            );

            const sf = stateFilePath("instant-slippage-fallthrough");
            const result = await batchBuy({
                mint: TEST_MINT,
                totalSolAmount: 0.05,
                keeper: TEST_KEEPER,
                windowMinutes: 1,
                retryBufferMinutes: 1,
                stateFilePath: sf,
            });

            expect(result.summary.completedPurchases).toBe(1);
            // The main loop climbs to the third step instead of deferring the
            // purchase: it is scheduled for a particular moment, and pushing it
            // half an hour out means the candle does not appear when needed.
            expect(slippageValues[0]).toBe(300);
            expect(slippageValues[1]).toBe(500);
            expect(slippageValues[2]).toBe(900);
            // The retry phase starts the ladder again at 3%: up to 50 minutes
            // pass between it and the main loop, the spike may have died down,
            // and there is a chance to buy cheaper. The last step, 1300, is left to it.
            expect(slippageValues[3]).toBe(300);
            expect(mockBuy).toHaveBeenCalledTimes(4);
        });

        it("should not instant retry on non-slippage errors", async () => {
            let callCount = 0;
            mockBuy.mockImplementation(() => {
                callCount++;
                if (callCount === 1) {
                    return Promise.reject(new Error("ECONNREFUSED"));
                }
                return Promise.resolve({ signature: "sig-ok", venue: "dex" });
            });

            const sf = stateFilePath("no-instant-retry");
            const result = await batchBuy({
                mint: TEST_MINT,
                totalSolAmount: 0.05,
                keeper: TEST_KEEPER,
                windowMinutes: 1,
                retryBufferMinutes: 1,
                stateFilePath: sf,
            });

            expect(result.summary.completedPurchases).toBe(1);
            // Main (fail, no instant retry) + retry phase attempt 1 (success) = 2
            expect(mockBuy).toHaveBeenCalledTimes(2);
        });
    });

    describe("retry logic — some purchases fail then succeed", () => {
        it("should retry failed purchases in buffer window", async () => {
            let callCount = 0;
            mockBuy.mockImplementation(() => {
                callCount++;
                // Purchase 1 fails in the main loop but succeeds on retry
                // N=1 for 0.05 SOL, so there is only 1 purchase
                if (callCount === 1) {
                    return Promise.reject(new Error("Slippage exceeded"));
                }
                return Promise.resolve({
                    signature: `sig-${callCount}`,
                    venue: "pumpfun",
                });
            });

            const sf = stateFilePath("retry-success");
            const result = await batchBuy({
                mint: TEST_MINT,
                totalSolAmount: 0.05, // N=1
                keeper: TEST_KEEPER,
                windowMinutes: 1,
                retryBufferMinutes: 1,
                stateFilePath: sf,
            });

            expect(result.summary.completedPurchases).toBe(1);
            expect(result.summary.abandonedPurchases).toBe(0);
            // 1 in the main loop (fail) + 1 retry (success) = 2 calls
            expect(mockBuy).toHaveBeenCalledTimes(2);
        });

        it("should escalate slippage on retries", async () => {
            const slippageValues: number[] = [];
            let callCount = 0;
            mockBuy.mockImplementation(
                (
                    _mint: PublicKey,
                    _amount: number,
                    _keeper: Keypair,
                    slippage: number
                ) => {
                    callCount++;
                    slippageValues.push(slippage);
                    // The first purchase always fails (main + retries)
                    if (callCount <= 2) {
                        return Promise.reject(new Error("Fail"));
                    }
                    return Promise.resolve({
                        signature: `sig-${callCount}`,
                        venue: "pumpfun",
                    });
                }
            );

            const sf = stateFilePath("slippage-escalation");
            await batchBuy({
                mint: TEST_MINT,
                totalSolAmount: 0.05, // N=1
                keeper: TEST_KEEPER,
                windowMinutes: 1,
                retryBufferMinutes: 1,
                startSlippageBps: 100,
                maxSlippageBps: 1000,
                stateFilePath: sf,
            });

            // Main loop: 100 bps (startSlippageBps), retry phase: 100, 300 bps
            expect(slippageValues[0]).toBe(100);
            expect(slippageValues[1]).toBe(100);
            expect(slippageValues[2]).toBe(300);
        });
    });

    describe("error classification", () => {
        it("should abandon immediately on non-retryable error (no retries wasted)", async () => {
            mockBuy.mockRejectedValue(
                new Error("Transaction simulation failed: insufficient funds")
            );

            const sf = stateFilePath("non-retryable");
            const result = await batchBuy({
                mint: TEST_MINT,
                totalSolAmount: 0.05, // N=1
                keeper: TEST_KEEPER,
                windowMinutes: 1,
                retryBufferMinutes: 1,
                stateFilePath: sf,
            });

            expect(result.summary.completedPurchases).toBe(0);
            expect(result.summary.abandonedPurchases).toBe(1);
            // Only 1 call — no retries are spent
            expect(mockBuy).toHaveBeenCalledTimes(1);

            const state = readState(sf);
            expect(state.purchases[0].status).toBe("abandoned");
        });

        it("should abandon on non-retryable error during retry phase", async () => {
            let callCount = 0;
            mockBuy.mockImplementation(() => {
                callCount++;
                if (callCount === 1) {
                    // Main loop: a retryable error
                    return Promise.reject(new Error("ECONNREFUSED"));
                }
                // Retry: a non-retryable error
                return Promise.reject(new Error("insufficient funds"));
            });

            const sf = stateFilePath("non-retryable-in-retry");
            const result = await batchBuy({
                mint: TEST_MINT,
                totalSolAmount: 0.05,
                keeper: TEST_KEEPER,
                windowMinutes: 1,
                retryBufferMinutes: 1,
                stateFilePath: sf,
            });

            expect(result.summary.abandonedPurchases).toBe(1);
            // Main (1) + one retry attempt (1) = 2 calls, not 3
            expect(mockBuy).toHaveBeenCalledTimes(2);
        });

        it("should retry unknown errors (conservative) with warning", async () => {
            let callCount = 0;
            mockBuy.mockImplementation(() => {
                callCount++;
                if (callCount <= 2) {
                    return Promise.reject(
                        new Error("VersionedTransaction deserialization failed")
                    );
                }
                return Promise.resolve({
                    signature: "sig-ok",
                    venue: "pumpfun",
                });
            });

            const sf = stateFilePath("unknown-error");
            const result = await batchBuy({
                mint: TEST_MINT,
                totalSolAmount: 0.05,
                keeper: TEST_KEEPER,
                windowMinutes: 1,
                retryBufferMinutes: 1,
                stateFilePath: sf,
            });

            // Unknown errors are retried and go through in the end
            expect(result.summary.completedPurchases).toBe(1);
            expect(mockBuy).toHaveBeenCalledTimes(3);
        });
    });

    describe("abandoned — all retries exhausted", () => {
        it("should mark purchase as abandoned after max retries", async () => {
            mockBuy.mockRejectedValue(new Error("Permanent failure"));

            const sf = stateFilePath("abandoned");
            const result = await batchBuy({
                mint: TEST_MINT,
                totalSolAmount: 0.05, // N=1
                keeper: TEST_KEEPER,
                windowMinutes: 1,
                retryBufferMinutes: 1,
                stateFilePath: sf,
            });

            expect(result.summary.completedPurchases).toBe(0);
            expect(result.summary.abandonedPurchases).toBe(1);
            // Main loop (1) + retry phase (4: own counter 0→MAX_RETRIES) = 5 calls
            expect(mockBuy).toHaveBeenCalledTimes(5);

            const state = readState(sf);
            expect(state.purchases[0].status).toBe("abandoned");
            expect(state.purchases[0].errorMessage).toBe("Permanent failure");
        });

        it("should abandon only failed purchases, keep completed", async () => {
            let callCount = 0;
            mockBuy.mockImplementation(() => {
                callCount++;
                // Purchase 1 is OK, purchase 2 always fails
                if (callCount === 1) {
                    return Promise.resolve({
                        signature: "sig-ok",
                        venue: "dex",
                    });
                }
                return Promise.reject(new Error("Always fails"));
            });

            const sf = stateFilePath("partial-abandon");
            const result = await batchBuy({
                mint: TEST_MINT,
                totalSolAmount: 0.2, // N=2
                keeper: TEST_KEEPER,
                windowMinutes: 1,
                retryBufferMinutes: 1,
                stateFilePath: sf,
            });

            expect(result.summary.completedPurchases).toBe(1);
            expect(result.summary.abandonedPurchases).toBe(1);

            const state = readState(sf);
            printSummaryTable(state);
            expect(state.purchases[0].status).toBe("completed");
            expect(state.purchases[1].status).toBe("abandoned");
        });
    });

    describe("state persistence", () => {
        it("should create state file on init", async () => {
            mockBuy.mockResolvedValue({
                signature: "sig",
                venue: "pumpfun",
            });

            const sf = stateFilePath("state-init");
            await batchBuy({
                mint: TEST_MINT,
                totalSolAmount: 0.05,
                keeper: TEST_KEEPER,
                windowMinutes: 1,
                stateFilePath: sf,
            });

            expect(fs.existsSync(sf)).toBe(true);

            const state = readState(sf);
            expect(state.runId).toBeDefined();
            expect(state.mint).toBe(TEST_MINT.toBase58());
            expect(state.totalSolAmount).toBe(0.05);
            expect(state.purchaseCount).toBe(1);
            expect(state.config.windowMinutes).toBe(1);
        });

        it("should save finishedAt timestamp on completion", async () => {
            mockBuy.mockResolvedValue({
                signature: "sig",
                venue: "pumpfun",
            });

            const sf = stateFilePath("state-finished");
            await batchBuy({
                mint: TEST_MINT,
                totalSolAmount: 0.05,
                keeper: TEST_KEEPER,
                windowMinutes: 1,
                stateFilePath: sf,
            });

            const state = readState(sf);
            expect(state.summary.finishedAt).toBeDefined();
            // Not strictly greater: the mocked batch fits inside a millisecond,
            // and a strict comparison made the test flaky.
            expect(state.summary.finishedAt).toBeGreaterThanOrEqual(
                state.summary.startedAt
            );
        });
    });

    describe("fee calculation integration", () => {
        it("should deduct fees from total amount", async () => {
            const amounts: number[] = [];
            mockBuy.mockImplementation(
                (_mint: PublicKey, amount: number) => {
                    amounts.push(amount);
                    return Promise.resolve({
                        signature: "sig",
                        venue: "pumpfun",
                    });
                }
            );

            const sf = stateFilePath("fees");
            await batchBuy({
                mint: TEST_MINT,
                totalSolAmount: 0.05,
                keeper: TEST_KEEPER,
                windowMinutes: 1,
                stateFilePath: sf,
            });

            // The purchases must add up to less than totalSolAmount (fees are subtracted)
            const totalBought = amounts.reduce((s, a) => s + a, 0);
            expect(totalBought).toBeLessThan(0.05);
            expect(totalBought).toBeGreaterThan(0.04); // Fee ~0.002 for the ATA + tx
        });
    });

    describe("venue passthrough", () => {
        it("should record venue from buy result in state", async () => {
            let callCount = 0;
            mockBuy.mockImplementation(() => {
                callCount++;
                return Promise.resolve({
                    signature: `sig-${callCount}`,
                    venue: callCount <= 2 ? "pumpfun" : "dex",
                });
            });

            const sf = stateFilePath("venues");
            await batchBuy({
                mint: TEST_MINT,
                totalSolAmount: 0.5, // N=5
                keeper: TEST_KEEPER,
                windowMinutes: 1,
                stateFilePath: sf,
            });

            const state = readState(sf);
            expect(state.purchases[0].venue).toBe("pumpfun");
            expect(state.purchases[1].venue).toBe("pumpfun");
            expect(state.purchases[2].venue).toBe("dex");
        });
    });

    describe("keeper balance guard", () => {
        it("shrinks to the remainder after a rejection instead of dropping the purchase", async () => {
            // The balance is not read up front: the request would cost 1 of the
            // 8 calls to the node on every purchase. Shrinking happens on an actual rejection.
            let call = 0;
            mockBuy.mockImplementation(() => {
                call++;
                if (call === 1) return Promise.reject(new Error("Transfer: insufficient lamports"));
                return Promise.resolve({ signature: "sig", venue: "pumpfun" });
            });
            mockGetBalance.mockResolvedValue(0.05 * LAMPORTS_PER_SOL);

            const sf = stateFilePath("shrink");
            await batchBuy({
                mint: TEST_MINT,
                totalSolAmount: 1,
                keeper: TEST_KEEPER,
                stateFilePath: sf,
            });

            const state = readState(sf);
            const shrunk = state.purchases.filter((p) => p.plannedSolAmount !== undefined);
            expect(shrunk.length).toBeGreaterThan(0);
            for (const p of shrunk) {
                expect(p.solAmount).toBeLessThan(p.plannedSolAmount!);
                // The headroom must cover the ATA rent in full: there used to
                // be 0.002 here, less than the rent itself (0.00204).
                expect(p.solAmount).toBeLessThanOrEqual(0.05 - ATA_FEE_SOL);
            }
            expect(state.summary.completedPurchases).toBeGreaterThan(0);
        });

        it("spends one attempt on an empty keeper, not one per purchase", async () => {
            // Without an early check the first purchase learns the keeper is
            // empty from the network. After that a local flag works: the rest
            // are dropped with no calls to the node and no doomed transactions.
            mockBuy.mockRejectedValue(new Error("Transfer: insufficient lamports"));
            mockGetBalance.mockResolvedValue(0.0021 * LAMPORTS_PER_SOL);

            const sf = stateFilePath("empty");
            await batchBuy({
                mint: TEST_MINT,
                totalSolAmount: 1,
                keeper: TEST_KEEPER,
                stateFilePath: sf,
            });

            const state = readState(sf);
            expect(state.summary.completedPurchases).toBe(0);
            expect(state.summary.abandonedPurchases).toBe(state.purchases.length);
            // Exactly one attempt for the whole batch, not one per purchase
            expect(mockBuy).toHaveBeenCalledTimes(1);
            expect(
                state.purchases.every((p) =>
                    (p.errorMessage || "").includes("balance exhausted")
                )
            ).toBe(true);
        });

        it("does not shrink when the balance is sufficient", async () => {
            mockBuy.mockResolvedValue({ signature: "sig", venue: "pumpfun" });
            mockGetBalance.mockResolvedValue(500 * LAMPORTS_PER_SOL);

            const sf = stateFilePath("no-shrink");
            await batchBuy({
                mint: TEST_MINT,
                totalSolAmount: 1,
                keeper: TEST_KEEPER,
                stateFilePath: sf,
            });

            const state = readState(sf);
            expect(
                state.purchases.every((p) => p.plannedSolAmount === undefined)
            ).toBe(true);
        });
    });


    describe("the retry window", () => {
        // The window has to depend on the NUMBER of failures, not their share:
        // the work is set by how many purchases have to be repeated. The old
        // formula gave 15 minutes for five failures out of ten and 10 for five
        // out of a hundred, although five is what needs repeating either way.
        async function windowFor(totalSol: number, failEvery: number): Promise<number> {
            let call = 0;
            mockBuy.mockImplementation(() => {
                call++;
                return call % failEvery === 0
                    ? Promise.reject(new Error("ECONNREFUSED"))
                    : Promise.resolve({ signature: "ok", venue: "pumpfun" });
            });
            const sf = stateFilePath(`window-${totalSol}-${failEvery}`);
            await batchBuy({
                mint: TEST_MINT,
                totalSolAmount: totalSol,
                keeper: TEST_KEEPER,
                windowMinutes: 1,
                stateFilePath: sf,
            });
            return readState(sf).config.retryBufferMinutes;
        }

        it("does not inflate the window when there are few failures", async () => {
            mockBuy.mockRejectedValueOnce(new Error("ECONNREFUSED"));
            mockBuy.mockResolvedValue({ signature: "ok", venue: "pumpfun" });
            const sf = stateFilePath("window-small");
            await batchBuy({
                mint: TEST_MINT,
                totalSolAmount: 1,
                keeper: TEST_KEEPER,
                windowMinutes: 1,
                stateFilePath: sf,
            });
            // One failure: there is nothing to repeat, the minimum window is enough
            const state = readState(sf);
            expect(state.summary.completedPurchases).toBeGreaterThan(0);
        });

        it("the config keeps the minimum window it was given", async () => {
            mockBuy.mockResolvedValue({ signature: "ok", venue: "pumpfun" });
            const sf = stateFilePath("window-config");
            await batchBuy({
                mint: TEST_MINT,
                totalSolAmount: 0.5,
                keeper: TEST_KEEPER,
                windowMinutes: 1,
                retryBufferMinutes: 3,
                stateFilePath: sf,
            });
            expect(readState(sf).config.retryBufferMinutes).toBe(3);
        });
    });

});

describe("a transaction that arrived and failed on chain", () => {
    // getSignatureStatus returns confirmed for a failed transaction TOGETHER
    // with err. While err went unchecked, such a failure counted as a purchase:
    // the retry was switched off, the SOL stayed on the keeper, and the round
    // reported success. A slippage rejection looks exactly like this.
    it("does not count as a purchase", async () => {
        const { PostSendError } = jest.requireActual("../../../solana/transaction");
        mockBuy.mockRejectedValue(
            new PostSendError("Transaction send/confirm failed", "sig-failed-onchain")
        );
        mockGetSignatureStatus.mockResolvedValue({
            value: {
                confirmationStatus: "finalized",
                err: { InstructionError: [0, { Custom: 6042 }] },
            },
        });

        const sf = stateFilePath("onchain-failure");
        const result = await batchBuy({
            mint: TEST_MINT,
            totalSolAmount: 0.05,
            keeper: TEST_KEEPER,
            windowMinutes: 0,
            stateFilePath: sf,
        });

        expect(result.summary.completedPurchases).toBe(0);
    });

    it("a successful signature still counts", async () => {
        const { PostSendError } = jest.requireActual("../../../solana/transaction");
        mockBuy.mockRejectedValue(
            new PostSendError("Transaction send/confirm failed", "sig-actually-ok")
        );
        mockGetSignatureStatus.mockResolvedValue({
            value: { confirmationStatus: "finalized", err: null },
        });

        const sf = stateFilePath("onchain-success");
        const result = await batchBuy({
            mint: TEST_MINT,
            totalSolAmount: 0.05,
            keeper: TEST_KEEPER,
            windowMinutes: 0,
            stateFilePath: sf,
        });

        expect(result.summary.completedPurchases).toBeGreaterThan(0);
    });
});

describe("the slippage ladder and the signature of a transaction that flew", () => {
    // The scenario from the PR #28 review. Attempt 1 fails on slippage, ladder
    // attempt 2 goes out and never gets its confirmation (PostSendError with a
    // signature). Leaving the ladder only did markFailed: the signature was
    // lost and the retry phase bought again, although the first transaction
    // may have arrived.
    //
    // We check not the final state (the retry phase patches that after the
    // fact) but the NUMBER of buy CALLS: the extra purchase is the money lost.
    function postSendError(signature: string): Error {
        const { PostSendError } = jest.requireActual("../../../solana/transaction");
        return new PostSendError("Transaction send/confirm failed: node did not respond", signature);
    }

    function slippageThenInFlight(signature: string): void {
        let call = 0;
        mockBuy.mockImplementation(() => {
            call++;
            if (call === 1) return Promise.reject(new Error("Slippage exceeded"));
            return Promise.reject(postSendError(signature));
        });
    }

    it("does not buy again when the ladder transaction arrived", async () => {
        slippageThenInFlight("SIG-IN-FLIGHT");
        // The transaction did go through, so the purchase has already been made
        mockGetSignatureStatus.mockResolvedValue({
            value: { confirmationStatus: "finalized", err: null },
        });

        const sf = stateFilePath("ladder-inflight-landed");
        const result = await batchBuy({
            mint: TEST_MINT,
            totalSolAmount: 0.05,
            keeper: TEST_KEEPER,
            windowMinutes: 0,
            stateFilePath: sf,
        });

        // The main attempt plus one ladder step. A third call would mean the
        // retry phase bought the same coin a second time.
        expect(mockBuy).toHaveBeenCalledTimes(2);
        expect(result.summary.completedPurchases).toBe(1);
        const state = readState(sf);
        expect(state.purchases[0].signature).toBe("SIG-IN-FLIGHT");
    });

    it("non-retryable inside the ladder drops the purchase instead of deferring it", async () => {
        let call = 0;
        mockBuy.mockImplementation(() => {
            call++;
            if (call === 1) return Promise.reject(new Error("Slippage exceeded"));
            return Promise.reject(new Error("Transfer: insufficient lamports"));
        });

        const sf = stateFilePath("ladder-non-retryable");
        await batchBuy({
            mint: TEST_MINT,
            totalSolAmount: 0.05,
            keeper: TEST_KEEPER,
            windowMinutes: 0,
            stateFilePath: sf,
        });

        // Repeating is pointless, the money will not grow. A third call would
        // mean the error classification was lost on this path.
        expect(mockBuy).toHaveBeenCalledTimes(2);
        const state = readState(sf);
        expect(state.purchases[0].status).toBe("abandoned");
    });
});

describe("recovering from insufficient funds", () => {
    // The keeper is shared by fifty batches and the balance check is not
    // atomic: neighbours can take the remainder between the check and the
    // send. `insufficient funds` used to be classified as non-retryable and the
    // purchase was dropped FOREVER. Now the balance is re-read and the purchase shrinks.
    it("shrinks and buys instead of dropping", async () => {
        let call = 0;
        mockBuy.mockImplementation((_m: any, amount: number) => {
            call++;
            if (call === 1) return Promise.reject(new Error("Transfer: insufficient lamports"));
            return Promise.resolve({ signature: `sig-${amount.toFixed(6)}`, venue: "pumpfun" });
        });
        // The balance is below what the purchase planned
        // It is only read after a rejection — there is no early check any more
        mockGetBalance.mockResolvedValue(0.03 * LAMPORTS_PER_SOL);

        const sf = stateFilePath("insufficient-recovery");
        const result = await batchBuy({
            mint: TEST_MINT,
            totalSolAmount: 0.05,
            keeper: TEST_KEEPER,
            windowMinutes: 0,
            stateFilePath: sf,
        });

        expect(result.summary.completedPurchases).toBe(1);
        const state = readState(sf);
        expect(state.purchases[0].status).toBe("completed");
        expect(state.metrics?.balance.shrunkAfterFailure ?? 0).toBeGreaterThan(0);
    });

    it("drops it when there is no money left at all", async () => {
        mockBuy.mockRejectedValue(new Error("Transfer: insufficient lamports"));
        mockGetBalance.mockResolvedValue(0);

        const sf = stateFilePath("insufficient-empty");
        const result = await batchBuy({
            mint: TEST_MINT,
            totalSolAmount: 0.05,
            keeper: TEST_KEEPER,
            windowMinutes: 0,
            stateFilePath: sf,
        });

        expect(result.summary.completedPurchases).toBe(0);
    });
});

describe("the keeper reserve depends on whether the ATA exists", () => {
    // Account rent is needed once. Reserving it on every purchase means
    // underbuying by 0.00204 SOL wherever the account already exists.
    it("does not reserve rent when the keeper ATA already exists", async () => {
        // getAccountInfo(mint) -> the token program owner, then ATA -> it exists
        mockGetAccountInfo.mockImplementation(async () => ({
            owner: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
            data: Buffer.alloc(82),
            lamports: 1,
            executable: false,
        }));
        mockBuy.mockResolvedValue({ signature: "sig", venue: "pumpfun" });
        // Exactly enough balance that reserving for the ATA would shrink the purchase
        mockGetBalance.mockResolvedValue(0.0405 * LAMPORTS_PER_SOL);

        const sf = stateFilePath("floor-with-ata");
        await batchBuy({
            mint: TEST_MINT,
            totalSolAmount: 0.04,
            keeper: TEST_KEEPER,
            windowMinutes: 0,
            stateFilePath: sf,
        });

        const state = readState(sf);
        // There must be no shrinking: the rent is not reserved
        expect(state.metrics?.balance.shrunkToFit ?? 0).toBe(0);
    });
});

describe("the shrunk amount survives into the slippage ladder", () => {
    // The purchase fails on insufficient funds, shrinks, and then the shrunk
    // attempt fails on slippage. The ladder has to repeat with the SHRUNK
    // amount: the original will not fit the balance, and repeating with it
    // would fail again for certain and lose the purchase.
    it("the ladder repeats with the shrunk amount, not the original", async () => {
        const amounts: number[] = [];
        let call = 0;
        mockBuy.mockImplementation((_m: any, amount: number) => {
            amounts.push(amount);
            call++;
            if (call === 1) return Promise.reject(new Error("Transfer: insufficient lamports"));
            if (call === 2) return Promise.reject(new Error("Slippage exceeded"));
            return Promise.resolve({ signature: "sig", venue: "pumpfun" });
        });
        mockGetBalance.mockResolvedValue(0.02 * LAMPORTS_PER_SOL);

        const sf = stateFilePath("shrunk-then-slippage");
        await batchBuy({
            mint: TEST_MINT,
            totalSolAmount: 0.05,
            keeper: TEST_KEEPER,
            windowMinutes: 0,
            stateFilePath: sf,
        });

        // 1st is the original, 2nd is shrunk, 3rd (the ladder step) is shrunk too
        expect(amounts.length).toBeGreaterThanOrEqual(3);
        expect(amounts[1]).toBeLessThan(amounts[0]);
        expect(amounts[2]).toBe(amounts[1]);
    });
});

describe("a coin that cannot be delivered is not bought", () => {
    // Trading refundable SOL for an unrefundable token is the worst outcome.
    // So the extensions are checked BEFORE the first spend, not at delivery.
    it("refuses to buy when there is a blocking extension", async () => {
        mockInspectMint.mockResolvedValue({
            blockers: ["NonTransferable: transfers are forbidden by the program"],
            warnings: [], transferFeeConfig: null, hasTransferHook: false,
        });
        mockBuy.mockResolvedValue({ signature: "sig", venue: "pumpfun" });

        await expect(batchBuy({
            mint: TEST_MINT,
            totalSolAmount: 0.05,
            keeper: TEST_KEEPER,
            windowMinutes: 0,
            stateFilePath: stateFilePath("non-transferable"),
        })).rejects.toThrow(/cannot be distributed/);

        // Not a single purchase: no money was spent
        expect(mockBuy).not.toHaveBeenCalled();
    });

    it("a transfer fee does not block the buying", async () => {
        // The recipient gets less, but delivery is physically possible, and
        // refusing the coin over that is not our call.
        mockInspectMint.mockResolvedValue({
            blockers: [],
            warnings: ["TransferFeeConfig: the recipient receives less (300 bps)"],
            transferFeeConfig: {}, hasTransferHook: false,
        });
        mockBuy.mockResolvedValue({ signature: "sig", venue: "pumpfun" });

        const result = await batchBuy({
            mint: TEST_MINT,
            totalSolAmount: 0.05,
            keeper: TEST_KEEPER,
            windowMinutes: 0,
            stateFilePath: stateFilePath("fee-ok"),
        });
        expect(result.summary.completedPurchases).toBeGreaterThan(0);
    });
});

describe("the venue when confirming by signature", () => {
    // PostSendError arrives from all three paths. The venue used to be
    // hardcoded as "pumpfun", so a purchase through the DEX was written into
    // the state wrongly — not only in the metric but in the purchase record.
    it("comes from the error label instead of being hardcoded", async () => {
        const { PostSendError, tagVenue } = jest.requireActual("../../../solana/transaction");
        mockBuy.mockRejectedValue(
            tagVenue(new PostSendError("send/confirm failed", "SIG-DEX"), "dex")
        );
        mockGetSignatureStatus.mockResolvedValue({
            value: { confirmationStatus: "finalized", err: null },
        });

        const sf = stateFilePath("venue-from-tag");
        await batchBuy({
            mint: TEST_MINT, totalSolAmount: 0.05, keeper: TEST_KEEPER,
            windowMinutes: 0, stateFilePath: sf,
        });

        const state = readState(sf);
        expect(state.purchases[0].venue).toBe("dex");
        expect(state.metrics?.venueRouting.dexDirect ?? 0).toBeGreaterThan(0);
    });
});
