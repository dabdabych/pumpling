// tests/unit/orchestrator/refunds.test.ts
// Returning the SOL that could not be spent on buying.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Keypair, Transaction } from "@solana/web3.js";

jest.mock("../../../solana/connection", () => ({
    connection: { getSignatureStatus: jest.fn() },
}));

import {
    MIN_REFUND_SOL,
    REFUND_BATCH_SIZE,
    planRefunds,
    refundUnspent,
    stakesByMint,
} from "../../../orchestrator/refunds";
import { OrchestratorStateManager } from "../../../orchestrator/state";
import { LotteryState } from "../../../orchestrator/types";
import { TX_FEE_SOL } from "../../../scheduler/fees";

// =============================================================================
// HELPERS
// =============================================================================

const MINT = Keypair.generate().publicKey.toBase58();
const ALICE = Keypair.generate().publicKey.toBase58();
const BOB = Keypair.generate().publicKey.toBase58();

function makeState(overrides?: Partial<LotteryState>): LotteryState {
    return {
        lotteryId: "128",
        totalSol: 10,
        sendReserve: 0,
        buyBudget: 10,
        config: { buyConcurrency: 1, sendConcurrency: 1, buyWindowMinutes: 50, sendRounds: 2 },
        tokenBuys: [{ mint: MINT, adjustedSolAmount: 10, status: "completed", spentSol: 6, updatedAt: 1 }],
        sends: [
            // One commit produces several deliveries across rounds.
            { id: "s1", mint: MINT, recipient: ALICE, recipientBetSol: 3, share: 0.75, sendN: 2, round: 1, status: "completed", attempts: 1, updatedAt: 1 },
            { id: "s2", mint: MINT, recipient: ALICE, recipientBetSol: 3, share: 0.75, sendN: 2, round: 2, status: "completed", attempts: 1, updatedAt: 1 },
            { id: "s3", mint: MINT, recipient: BOB, recipientBetSol: 1, share: 0.25, sendN: 1, round: 1, status: "completed", attempts: 1, updatedAt: 1 },
        ],
        summary: {
            tokensBought: 1, tokensFailed: 0, sendsTotal: 3, sendsCompleted: 3,
            sendsSatisfied: 0, sendsAbandoned: 0, sendsAtaMismatch: 0, startedAt: 1,
        },
        ...overrides,
    } as LotteryState;
}

function managerFor(state: LotteryState): OrchestratorStateManager {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "refund-test-"));
    return OrchestratorStateManager.create(state, path.join(dir, "lottery_128.json"));
}

const keeper = Keypair.generate();

// =============================================================================
// TESTS
// =============================================================================

describe("who stands behind which coin", () => {
    it("a commit is counted once, not per delivery", () => {
        const stakes = stakesByMint(makeState());

        expect(stakes.get(MINT)?.get(ALICE)).toBe(3);
        expect(stakes.get(MINT)?.get(BOB)).toBe(1);
    });
});

describe("the refund plan", () => {
    it("splits the remainder by commit size and subtracts the fee", () => {
        const plan = planRefunds(makeState(), new Map([[MINT, 6]]));

        const alice = plan.find((item) => item.recipient === ALICE)!;
        const bob = plan.find((item) => item.recipient === BOB)!;

        // 4 SOL went unspent: three quarters to Alice, a quarter to Bob.
        expect(alice.grossSol).toBeCloseTo(3, 9);
        expect(bob.grossSol).toBeCloseTo(1, 9);
        // One transaction's fee is split between the recipients in the batch.
        const expectedFee = TX_FEE_SOL / 2;
        expect(alice.feeSol).toBeCloseTo(expectedFee, 9);
        expect(alice.amountSol).toBeCloseTo(3 - expectedFee, 9);
        expect(bob.amountSol).toBeCloseTo(1 - expectedFee, 9);
        expect(alice.status).toBe("pending");
    });

    it("nothing to return when it was all spent", () => {
        const plan = planRefunds(makeState(), new Map([[MINT, 10]]));
        expect(plan).toEqual([]);
    });

    it("pennies are not sent: the fee would eat them whole", () => {
        const state = makeState();
        state.tokenBuys[0].adjustedSolAmount = 6.004; // four thousandths unspent
        const plan = planRefunds(state, new Map([[MINT, 6]]));

        const bob = plan.find((item) => item.recipient === BOB)!;
        expect(bob.status).toBe("skipped");
        expect(bob.amountSol).toBe(0);
        expect(bob.errorMessage).toContain("network fee");
    });

    it("the refund threshold is above the fee", () => {
        expect(MIN_REFUND_SOL).toBeGreaterThan(TX_FEE_SOL * 10);
    });

    it("a coin with no participants does not break the calculation", () => {
        const state = makeState({ sends: [] });
        expect(planRefunds(state, new Map([[MINT, 1]]))).toEqual([]);
    });

    it("the refunds never exceed the remainder", () => {
        const plan = planRefunds(makeState(), new Map([[MINT, 6]]));
        const total = plan.reduce((sum, item) => sum + item.amountSol, 0);
        expect(total).toBeLessThanOrEqual(4);
    });
});

describe("sending the refunds", () => {
    it("sends one transaction and marks them done", async () => {
        const manager = managerFor(makeState());
        const sent: Transaction[] = [];

        const result = await refundUnspent(manager, new Map([[MINT, 6]]), {
            keeper,
            send: async (tx) => {
                sent.push(tx);
                return "sig-refund";
            },
        });

        expect(sent).toHaveLength(1);
        // Two budget instructions plus two transfers.
        expect(sent[0].instructions).toHaveLength(4);
        const budget = sent[0].instructions.filter((ix: any) =>
            ix.programId.toBase58() === "ComputeBudget111111111111111111111111111111");
        expect(budget).toHaveLength(2);
        expect(result.sent).toBe(2);
        expect(result.solReturned).toBeCloseTo(4 - TX_FEE_SOL, 6);
        expect(manager.getState().refunds?.every((refund) => refund.signature === "sig-refund")).toBe(true);
    });

    it("a second pass sends nothing again", async () => {
        const manager = managerFor(makeState());
        let calls = 0;
        const send = async () => {
            calls++;
            return "sig-refund";
        };

        await refundUnspent(manager, new Map([[MINT, 6]]), { keeper, send });
        await refundUnspent(manager, new Map([[MINT, 6]]), { keeper, send });

        expect(calls).toBe(1);
    });

    it("a signature in the error means \"it went out\": there is no second send", async () => {
        const manager = managerFor(makeState());
        const failure = Object.assign(new Error("confirmation timeout"), { signature: "sig-maybe" });

        await refundUnspent(manager, new Map([[MINT, 6]]), {
            keeper,
            send: async () => {
                throw failure;
            },
        });

        const refunds = manager.getState().refunds!;
        expect(refunds.every((refund) => refund.status === "in_progress")).toBe(true);
        expect(refunds.every((refund) => refund.pendingSignature === "sig-maybe")).toBe(true);

        // The next pass sees the transaction arrived and closes the refund.
        await refundUnspent(manager, new Map([[MINT, 6]]), {
            keeper,
            signatureLanded: async () => true,
            send: async () => {
                throw new Error("must not send a second time");
            },
        });

        expect(manager.getState().refunds!.every((refund) => refund.status === "completed")).toBe(true);
    });

    it("an unknown signature status leaves the refund hanging but never pays twice", async () => {
        const manager = managerFor(makeState());
        await refundUnspent(manager, new Map([[MINT, 6]]), {
            keeper,
            send: async () => {
                throw Object.assign(new Error("timeout"), { signature: "sig-unknown" });
            },
        });

        let attempted = false;
        await refundUnspent(manager, new Map([[MINT, 6]]), {
            keeper,
            signatureLanded: async () => null,
            send: async () => {
                attempted = true;
                return "sig-second";
            },
        });

        expect(attempted).toBe(false);
        expect(manager.getState().refunds!.every((refund) => refund.status === "in_progress")).toBe(true);
    });

    it("an error with no signature leaves the refund failed", async () => {
        const manager = managerFor(makeState());

        const result = await refundUnspent(manager, new Map([[MINT, 6]]), {
            keeper,
            send: async () => {
                throw new Error("node is down");
            },
        });

        expect(result.failed).toBe(2);
        expect(manager.getState().refunds!.every((refund) => refund.status === "failed")).toBe(true);
    });

    it("large rounds are split into batches", async () => {
        const many = Array.from({ length: REFUND_BATCH_SIZE * 2 + 3 }, (_, index) => ({
            id: `s${index}`,
            mint: MINT,
            recipient: Keypair.generate().publicKey.toBase58(),
            recipientBetSol: 1,
            share: 1 / (REFUND_BATCH_SIZE * 2 + 3),
            sendN: 1,
            round: 1,
            status: "completed" as const,
            attempts: 1,
            updatedAt: 1,
        }));
        const state = makeState({ sends: many });
        state.tokenBuys[0].adjustedSolAmount = 100;
        const manager = managerFor(state);

        let batches = 0;
        await refundUnspent(manager, new Map([[MINT, 6]]), {
            keeper,
            send: async () => {
                batches++;
                return `sig-${batches}`;
            },
        });

        expect(batches).toBe(3);
        expect(manager.getState().refunds!.filter((refund) => refund.status === "completed")).toHaveLength(many.length);
    });

    it("nothing to return, nothing happens", async () => {
        const manager = managerFor(makeState());
        let calls = 0;

        const result = await refundUnspent(manager, new Map([[MINT, 10]]), {
            keeper,
            send: async () => {
                calls++;
                return "sig";
            },
        });

        expect(calls).toBe(0);
        expect(result).toEqual({ sent: 0, skipped: 0, failed: 0, solReturned: 0 });
    });
});
