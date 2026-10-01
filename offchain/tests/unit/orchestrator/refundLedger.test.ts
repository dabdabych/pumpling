// tests/unit/orchestrator/refundLedger.test.ts
// What a coin was given, and what it actually cost.
//
// The round these numbers come from is 1790348400190 on mainnet, 2026-09-25:
// one coin, 29 purchases, six deliveries, two people behind it. The planned
// amounts are the ones in its batch file; the debits are what the chain says
// the keeper paid, read back through `getTransaction` on 2026-09-26.
//
// The point of testing against a real round rather than round numbers is that
// every one of the awkward cases turned up in it on its own: a purchase that
// also paid for the keeper's token account, four purchases at the priority
// ceiling and twenty-four far below it, a transaction that expired and never
// reached the chain, and two deliveries that shared one transaction.

import { Keypair } from "@solana/web3.js";

import { buildRefundLedger, collectRoundSignatures, settleDelivery } from "../../../orchestrator/refundLedger";
import { planRefunds } from "../../../orchestrator/refunds";
import { LotteryState, SendRecord } from "../../../orchestrator/types";
import { BatchState, PurchaseRecord } from "../../../scheduler/types";
import { ATA_FEE_SOL, BUY_TX_FEE_SOL, TX_FEE_SOL } from "../../../scheduler/fees";

const MINT = "56AsKxgMEVXcXSdqgzHHcPGJ7owdJwzfd9GyRvh8pump";
const BIG = "PrpNxdeSX8SwyUNv4H2pA7aZ6PRYzfAyEPPogCgCDnQ";
const SMALL = "BBAhmonxcKEWaxC5rwDXTLTknS8mqfSPn6asAPaqWpGb";

/** [planned, what the keeper actually paid] for each of the 29 purchases. */
const PURCHASES: Array<[number, number]> = [
    [0.370938552, 0.372457532], // this one also paid the rent of the token account
    [0.321944261, 0.321949401],
    [0.371802377, 0.371807517],
    [0.329603151, 0.329608291],
    [0.344051685, 0.344056825],
    [0.317822284, 0.317827424],
    [0.348162207, 0.348202277],
    [0.329927370, 0.329932510],
    [0.377490110, 0.377495250],
    [0.346403894, 0.346409034],
    [0.325942195, 0.325947335],
    [0.338792510, 0.338797650],
    [0.333890460, 0.333895600],
    [0.359708028, 0.359813028], // the four at the priority ceiling
    [0.331697522, 0.331802522],
    [0.366774465, 0.366879465],
    [0.365990801, 0.366095801],
    [0.331419594, 0.331424734],
    [0.350674556, 0.350715256],
    [0.360139982, 0.360145122],
    [0.314400731, 0.314405871],
    [0.366674034, 0.366679174],
    [0.360095968, 0.360101108],
    [0.331637265, 0.331642405],
    [0.375543770, 0.375548910],
    [0.356514566, 0.356519706],
    [0.362199359, 0.362204499],
    [0.374689988, 0.374695128], // bought on the retry; the first try expired
    [0.359298315, 0.359303455],
];

/** The five delivery transactions. The last one served two people at once. */
const DELIVERY_DEBITS: Array<[string, number]> = [
    ["send-1", 0.001518885],
    ["send-2", 0.000005045],
    ["send-3", 0.000005045],
    ["send-4", 0.000005045],
    ["send-5", 0.001518915],
];

const POOL_SOL = 10.1365;        // what the round put on the keeper
const SEND_RESERVE = 0.00414;    // held back for delivery
const ADJUSTED = 10.13236;       // the coin's allocation after that reserve
const PLANNED = 10.12423;        // the sum the batch reported as spent
const BUY_DEBIT = 10.126362830;  // what the purchases really took
const SEND_DEBIT = 0.003052935;  // what the deliveries really took

function purchases(): PurchaseRecord[] {
    return PURCHASES.map(([planned], index) => ({
        id: `p${index + 1}`,
        index: index + 1,
        scheduledAt: 0,
        solAmount: planned,
        status: "completed",
        signature: `buy-${index + 1}`,
        // The 28th was sent once, expired, and was bought again on the retry.
        // The expired signature is still on the record.
        pendingSignature: index === 27 ? "buy-28-expired" : undefined,
        venue: "pumpfun",
        attempts: index === 27 ? 2 : 1,
        updatedAt: 0,
    }));
}

function batch(overrides?: Partial<BatchState["config"]>): BatchState {
    return {
        runId: "batch_real",
        mint: MINT,
        totalSolAmount: ADJUSTED,
        purchaseCount: PURCHASES.length,
        config: {
            windowMinutes: 50,
            retryBufferMinutes: 3,
            startSlippageBps: 300,
            maxSlippageBps: 1300,
            hadAtaAtStart: false,
            ...overrides,
        },
        purchases: purchases(),
        summary: {
            completedPurchases: PURCHASES.length,
            abandonedPurchases: 0,
            totalSolSpent: PLANNED,
            startedAt: 1,
            finishedAt: 2,
        },
    };
}

function sends(): SendRecord[] {
    const rows: Array<[string, string, number, string]> = [
        ["s1", BIG, 10, "send-1"],
        ["s2", BIG, 10, "send-2"],
        ["s3", BIG, 10, "send-3"],
        ["s4", BIG, 10, "send-4"],
        ["s5", BIG, 10, "send-5"],
        // Delivered in the same transaction as s5.
        ["s6", SMALL, 0.45, "send-5"],
    ];
    return rows.map(([id, recipient, bet, signature], index) => ({
        id,
        mint: MINT,
        recipient,
        recipientBetSol: bet,
        share: bet / 10.45,
        sendN: recipient === BIG ? 5 : 1,
        round: index + 1,
        status: "completed",
        signature,
        hadAtaAtStart: false,
        attempts: 1,
        updatedAt: 0,
    }));
}

function state(overrides?: Partial<LotteryState>): LotteryState {
    return {
        lotteryId: "1790348400190",
        totalSol: POOL_SOL,
        sendReserve: SEND_RESERVE,
        buyBudget: ADJUSTED,
        config: { buyConcurrency: 50, sendConcurrency: 20, buyWindowMinutes: 50, sendRounds: 10 },
        tokenBuys: [{
            mint: MINT,
            targetSolAmount: POOL_SOL,
            adjustedSolAmount: ADJUSTED,
            status: "completed",
            spentSol: PLANNED,
            batchStateFile: "batch.json",
            updatedAt: 0,
        }],
        sends: sends(),
        summary: {
            tokensBought: 1, tokensFailed: 0, sendsTotal: 6, sendsCompleted: 6,
            sendsSatisfied: 0, sendsAbandoned: 0, sendsAtaMismatch: 0, startedAt: 1,
        },
        ...overrides,
    } as LotteryState;
}

const loader = (b: BatchState | null = batch()) => () => b;

/** Every debit the chain reported for that round. */
function chainDebits(): Map<string, number> {
    const debits = new Map<string, number>();
    PURCHASES.forEach(([, debit], index) => debits.set(`buy-${index + 1}`, debit));
    // The expired one is not on chain, so it cost nothing.
    debits.set("buy-28-expired", 0);
    for (const [signature, debit] of DELIVERY_DEBITS) {
        debits.set(signature, debit);
    }
    return debits;
}

// =============================================================================

describe("the signatures a round may have been charged for", () => {
    it("takes the purchases, the deliveries and the ones left pending", () => {
        const signatures = collectRoundSignatures(state(), loader());

        expect(signatures).toHaveLength(29 + 1 + 5);
        expect(signatures).toContain("buy-28-expired");
        // The two deliveries that shared a transaction are one signature.
        expect(signatures.filter((s) => s === "send-5")).toHaveLength(1);
    });

    it("still finds the deliveries when the batch file has gone", () => {
        // Deliveries live in the round's own state, so losing a batch file
        // costs us the purchases and nothing else.
        const signatures = collectRoundSignatures(state(), loader(null));

        expect(signatures).toEqual(["send-1", "send-2", "send-3", "send-4", "send-5"]);
    });
});

describe("a purchase signed more than once", () => {
    // Signed again after its blockhash ran out: the record keeps every attempt,
    // and the last one is also its pending signature from the moment it was signed.
    function resigned(): BatchState {
        const b = batch();
        b.purchases[27] = {
            ...b.purchases[27],
            pendingSignature: "buy-28",
            sentAttempts: [
                { signature: "buy-28-failed", lastValidBlockHeight: 1, at: 0 },
                { signature: "buy-28-expired", lastValidBlockHeight: 2, at: 0 },
                { signature: "buy-28", lastValidBlockHeight: 3, at: 0 },
            ],
        };
        return b;
    }

    it("asks the chain about every attempt", () => {
        const signatures = collectRoundSignatures(state(), loader(resigned()));
        expect(signatures).toContain("buy-28-failed");
        expect(signatures).toContain("buy-28-expired");
    });

    it("charges the fee of an attempt that landed and failed, even when it was not the last", () => {
        const debits = chainDebits();
        // Reached the chain and failed there: it paid its fee and bought nothing.
        debits.set("buy-28-failed", 0.000105);
        const plain = buildRefundLedger(state(), loader(), chainDebits()).get(MINT)!;
        const withAttempts = buildRefundLedger(state(), loader(resigned()), debits).get(MINT)!;
        expect(withAttempts.spentSol - plain.spentSol).toBeCloseTo(0.000105, 9);
        expect(withAttempts.exact).toBe(true);
    });
});

describe("what the round really cost", () => {
    it("counts the fees and the rent the plan does not know about", () => {
        const basis = buildRefundLedger(state(), loader(), chainDebits()).get(MINT)!;

        expect(basis.spentSol).toBeCloseTo(BUY_DEBIT, 9);
        expect(basis.exact).toBe(true);
        // The plan was short by the fees, the priority and the token account.
        expect(basis.spentSol - PLANNED).toBeCloseTo(0.00213283, 9);
    });

    it("counts a delivery transaction once, not once per recipient", () => {
        const settled = settleDelivery(state(), chainDebits());

        // Naively it would be counted twice: 0.001518915 more than the truth.
        expect(settled.spentSol).toBeCloseTo(SEND_DEBIT, 9);
        expect(settled.reserveSol).toBeCloseTo(SEND_RESERVE, 9);
        expect(settled.leftoverSol).toBeCloseTo(SEND_RESERVE - SEND_DEBIT, 9);
    });

    it("charges nothing for a transaction that never reached the chain", () => {
        const withExpiry = buildRefundLedger(state(), loader(), chainDebits()).get(MINT)!;
        const debits = chainDebits();
        debits.delete("buy-28-expired");
        const withoutIt = buildRefundLedger(state(), loader(), debits).get(MINT)!;

        // Known to be absent: free. Unknown: charged at the reserve, because
        // being wrong the other way is the keeper paying out of its own money.
        expect(withExpiry.spentSol).toBeLessThan(withoutIt.spentSol);
        expect(withoutIt.spentSol - withExpiry.spentSol).toBeCloseTo(BUY_TX_FEE_SOL, 9);
        expect(withoutIt.exact).toBe(false);
    });

    it("the delivery reserve is settled for the round, and handed back by allocation", () => {
        const basis = buildRefundLedger(state(), loader(), chainDebits()).get(MINT)!;

        expect(basis.allocatedSol).toBeCloseTo(ADJUSTED, 9);
        // One coin, so all of what delivery did not use comes back to it.
        expect(basis.deliveryLeftoverSol).toBeCloseTo(SEND_RESERVE - SEND_DEBIT, 9);
        expect(basis.allocatedSol + basis.deliveryLeftoverSol).toBeCloseTo(POOL_SOL - SEND_DEBIT, 9);
    });
});

describe("what happens when the chain cannot be read", () => {
    it("estimates a purchase upwards, never downwards", () => {
        const basis = buildRefundLedger(state(), loader(), new Map()).get(MINT)!;

        // Every purchase at its reserved ceiling, plus the token account once,
        // plus the attempt that expired.
        expect(basis.spentSol).toBeCloseTo(
            PLANNED + PURCHASES.length * BUY_TX_FEE_SOL + ATA_FEE_SOL + BUY_TX_FEE_SOL,
            9
        );
        expect(basis.spentSol).toBeGreaterThan(BUY_DEBIT);
        expect(basis.exact).toBe(false);
    });

    it("and estimates delivery upwards too, so the leftover shrinks", () => {
        const settled = settleDelivery(state(), new Map());

        // Five transactions and a token account for each of the two people.
        expect(settled.spentSol).toBeCloseTo(5 * TX_FEE_SOL + 2 * ATA_FEE_SOL, 9);
        expect(settled.spentSol).toBeGreaterThan(SEND_DEBIT);
        expect(settled.leftoverSol).toBeLessThan(SEND_RESERVE - SEND_DEBIT);
    });

    it("falls back to the old figures when the batch file has gone", () => {
        const basis = buildRefundLedger(state(), loader(null), chainDebits()).get(MINT)!;

        expect(basis.allocatedSol).toBeCloseTo(ADJUSTED, 9);
        expect(basis.spentSol).toBeCloseTo(PLANNED, 9);
        expect(basis.exact).toBe(false);
    });
});

describe("deliveries that have not finished yet", () => {
    it("hold back their fee, so a later pass can still pay for them", () => {
        const stuck = state();
        stuck.sends[2] = { ...stuck.sends[2], status: "in_progress", signature: undefined };

        const settled = settleDelivery(stuck, chainDebits());

        // One transaction's fee. The recipient's account already exists by
        // then, because an earlier delivery in this round made it.
        expect(settled.heldSol).toBeCloseTo(TX_FEE_SOL, 9);
        expect(settled.leftoverSol).toBeCloseTo(SEND_RESERVE - settled.spentSol - TX_FEE_SOL, 9);
    });

    it("hold nothing for one that failed: the sweeps are over and it is about to be abandoned", () => {
        const done = state();
        done.sends[2] = { ...done.sends[2], status: "failed", signature: undefined };

        expect(settleDelivery(done, chainDebits()).heldSol).toBe(0);
    });

    it("hold nothing when every delivery is settled one way or the other", () => {
        expect(settleDelivery(state(), chainDebits()).heldSol).toBe(0);
    });
});

describe("the round as a whole", () => {
    /** What the keeper is left with after buying, delivering and refunding. */
    function keeperNet(unspentBasis: { allocatedSol: number; spentSol: number; deliveryLeftoverSol: number; exact: boolean }): number {
        const plan = planRefunds(state(), new Map([[MINT, unspentBasis]]));
        // A refund costs the keeper the gross: the fee it keeps back is paid to
        // the network out of the same transaction.
        const paidOut = plan
            .filter((refund) => refund.status === "pending")
            .reduce((sum, refund) => sum + refund.grossSol, 0);
        return POOL_SOL - BUY_DEBIT - SEND_DEBIT - paidOut;
    }

    it("the old rule left the keeper paying for the round", () => {
        // Allocation net of the reserve, spend taken from the plan.
        const net = keeperNet({ allocatedSol: ADJUSTED, spentSol: PLANNED, deliveryLeftoverSol: 0, exact: false });

        expect(net).toBeLessThan(0);
        expect(net).toBeCloseTo(-0.000695671, 8);
    });

    it("the new one leaves it whole", () => {
        const ledger = buildRefundLedger(state(), loader(), chainDebits());
        const net = keeperNet(ledger.get(MINT)!);

        expect(net).toBeGreaterThan(0);
        // What is left is the one share too small to be worth a transaction,
        // and nothing else.
        expect(net).toBeCloseTo(0.000305063, 8);
    });

    it("and returns more than the old one, not less", () => {
        const ledger = buildRefundLedger(state(), loader(), chainDebits());
        const now = planRefunds(state(), ledger).find((r) => r.recipient === BIG)!;
        const before = planRefunds(state(), new Map([[MINT, {
            allocatedSol: ADJUSTED, spentSol: PLANNED, deliveryLeftoverSol: 0, exact: false,
        }]])).find((r) => r.recipient === BIG)!;

        // The unused delivery reserve goes back to people now, and it is worth
        // more than the fees that used to be refunded by mistake.
        expect(now.grossSol).toBeLessThan(before.grossSol);
        expect(before.grossSol - now.grossSol).toBeCloseTo(0.001000734, 8);
    });
});

describe("the fee a refund carries", () => {
    it("is one transaction's fee split between the people in it", () => {
        const plan = planRefunds(state(), new Map([[MINT, {
            allocatedSol: POOL_SOL, spentSol: 10, deliveryLeftoverSol: 0, exact: true,
        }]]));

        expect(plan[0].feeSol).toBeCloseTo(TX_FEE_SOL / 2, 9);
    });

    it("rounds up to whole transactions when there are more than eight", () => {
        const many = state({
            sends: Array.from({ length: 20 }, (_, i) => ({
                id: `s${i}`,
                mint: MINT,
                recipient: Keypair.generate().publicKey.toBase58(),
                recipientBetSol: 1,
                share: 0.05,
                sendN: 1,
                round: 1,
                status: "completed" as const,
                signature: `send-${i}`,
                attempts: 1,
                updatedAt: 0,
            })),
        });

        const plan = planRefunds(many, new Map([[MINT, {
            allocatedSol: POOL_SOL, spentSol: 9, deliveryLeftoverSol: 0, exact: true,
        }]]));
        const collected = plan.reduce((sum, refund) => sum + refund.feeSol, 0);

        // Twenty people are three transactions, not two and a half. The half
        // nobody was charged for used to come off the keeper.
        expect(collected).toBeCloseTo(TX_FEE_SOL * 3, 9);
    });
});

// =============================================================================
// SEVERAL COINS
// =============================================================================

/**
 * The delivery reserve belongs to the round, not to any one coin.
 *
 * Delivery costs what the recipients cost: about 0.0015 of rent for every
 * wallet that has never held the coin. A coin's allocation is its share of the
 * draw, and the draw can leave a coin with eight backers holding 0.05 SOL. Its
 * delivery then costs more than it was given.
 *
 * Charged to that coin alone, its refund goes negative, is skipped, and the
 * keeper covers the difference — while every other coin cheerfully refunds its
 * own unused share of the same reserve. Settled for the round, the reserve
 * pays for the deliveries it was taken for and only the true remainder goes
 * back. This is written down because the first version of this module did it
 * the first way.
 */
describe("a coin drawn small but backed by many", () => {
    // Everything here is built from the primitives, so the round's books
    // balance by construction rather than by transcription.
    const RENT = 0.00151384;          // measured on mainnet 2026-09-25
    const SEND_FEE = 0.000005045;     // one delivery transaction
    const TARGETS = [["A", 20], ["E", 0.05]] as Array<[string, number]>;
    const BACKERS: Record<string, number> = { A: 4, E: 8 };
    const POOL = TARGETS.reduce((sum, [, target]) => sum + target, 0);

    // What `calculateSendReserve` holds back: a fee per delivery and a token
    // account for every recipient that has none.
    const RESERVE = Object.values(BACKERS).reduce((sum, n) => sum + n * (TX_FEE_SOL + ATA_FEE_SOL), 0);
    const BUY_BUDGET = POOL - RESERVE;
    const ALLOCATED: Record<string, number> = Object.fromEntries(
        TARGETS.map(([mint, target]) => [mint, (BUY_BUDGET * target) / POOL])
    );
    // Five recipients to a transaction, one mint at a time.
    const TRANSACTIONS: Record<string, number> = Object.fromEntries(
        Object.entries(BACKERS).map(([mint, n]) => [mint, Math.ceil(n / 5)])
    );
    const DELIVERED = Object.entries(BACKERS).reduce(
        (sum, [mint, n]) => sum + n * RENT + TRANSACTIONS[mint] * SEND_FEE,
        0
    );
    // Each coin buys all it was given bar a little, the way a real batch does.
    const SPENT: Record<string, number> = Object.fromEntries(
        TARGETS.map(([mint]) => [mint, ALLOCATED[mint] * 0.999])
    );

    function manyCoins(): LotteryState {
        const sends: SendRecord[] = [];
        for (const [mint] of TARGETS) {
            for (let i = 0; i < BACKERS[mint]; i += 1) {
                sends.push({
                    id: `${mint}-${i}`,
                    mint,
                    recipient: `${mint}-wallet-${i}`,
                    recipientBetSol: 1,
                    share: 1 / BACKERS[mint],
                    sendN: 1,
                    round: 1,
                    status: "completed",
                    // Five to a transaction, so the signatures repeat.
                    signature: `${mint}-send-${Math.floor(i / 5)}`,
                    hadAtaAtStart: false,
                    attempts: 1,
                    updatedAt: 0,
                });
            }
        }
        return {
            ...state(),
            totalSol: POOL,
            sendReserve: RESERVE,
            buyBudget: BUY_BUDGET,
            tokenBuys: TARGETS.map(([mint]) => ({
                mint,
                adjustedSolAmount: ALLOCATED[mint],
                status: "completed" as const,
                spentSol: SPENT[mint],
                batchStateFile: `${mint}.json`,
                updatedAt: 0,
            })),
            sends,
        } as LotteryState;
    }

    /** What the chain says every transaction of this round cost. */
    function debitsOf(): Map<string, number> {
        const debits = new Map<string, number>();
        for (const [mint] of TARGETS) {
            debits.set(`${mint}-buy`, SPENT[mint]);
            for (let tx = 0; tx < TRANSACTIONS[mint]; tx += 1) {
                const recipients = Math.min(5, BACKERS[mint] - tx * 5);
                debits.set(`${mint}-send-${tx}`, recipients * RENT + SEND_FEE);
            }
        }
        return debits;
    }

    const coinLoader = (file?: string) => {
        const mint = TARGETS.map(([name]) => name).find((name) => `${name}.json` === file);
        if (!mint) return null;
        return {
            ...batch(),
            mint,
            purchases: [{
                id: "p1", index: 1, scheduledAt: 0, solAmount: SPENT[mint],
                status: "completed" as const, signature: `${mint}-buy`,
                attempts: 1, updatedAt: 0,
            }],
        } as BatchState;
    };

    const ledgerFor = () => buildRefundLedger(manyCoins(), coinLoader, debitsOf());

    it("costs more to deliver than it was given, which is the whole problem", () => {
        const deliveryOfSmall = BACKERS.E * RENT + TRANSACTIONS.E * SEND_FEE;

        expect(deliveryOfSmall).toBeGreaterThan(ALLOCATED.E - SPENT.E);
    });

    it("is still refunded something rather than skipped", () => {
        const small = ledgerFor().get("E")!;
        const unspent = small.allocatedSol - small.spentSol + small.deliveryLeftoverSol;

        // Charged to the coin alone this is below zero, the refund is dropped
        // and the keeper pays for those deliveries out of its own balance.
        expect(unspent).toBeGreaterThan(0);
    });

    it("leaves the keeper level, not out of pocket", () => {
        const ledger = ledgerFor();
        const refunded = [...ledger.values()].reduce(
            (sum, basis) => sum + (basis.allocatedSol - basis.spentSol + basis.deliveryLeftoverSol),
            0
        );
        const bought = TARGETS.reduce((sum, [mint]) => sum + SPENT[mint], 0);

        expect(POOL - bought - DELIVERED - refunded).toBeCloseTo(0, 9);
    });

    it("hands the leftover back by allocation, so nobody subsidises anybody", () => {
        const ledger = ledgerFor();
        const leftover = RESERVE - DELIVERED;
        const total = TARGETS.reduce((sum, [mint]) => sum + ALLOCATED[mint], 0);

        expect(leftover).toBeGreaterThan(0);
        for (const [mint] of TARGETS) {
            expect(ledger.get(mint)!.deliveryLeftoverSol)
                .toBeCloseTo((leftover * ALLOCATED[mint]) / total, 9);
        }
    });
});

describe("burns and earlier failed deliveries", () => {
    const burns = [
        { id: "b1", mint: MINT, rawAmount: "10", status: "completed" as const, signature: "burn-1", attempts: 1, createdAt: 0, updatedAt: 0 },
        { id: "b2", mint: MINT, rawAmount: "10", status: "in_progress" as const, pendingSignature: "burn-2", attempts: 1, createdAt: 0, updatedAt: 0 },
        { id: "b3", mint: MINT, rawAmount: "10", status: "failed" as const, pendingSignature: "burn-3", attempts: 1, createdAt: 0, updatedAt: 0 },
    ];

    it("asks the chain about every burn signature and every failed delivery attempt", () => {
        const withHistory = sends().map((send, index) => index === 0 ? { ...send, failedSignatures: ["send-failed-1"] } : send);
        const signatures = collectRoundSignatures(state({ burns, sends: withHistory }), loader());
        expect(signatures).toEqual(expect.arrayContaining(["burn-1", "burn-2", "burn-3", "send-failed-1"]));
    });

    it("charges the burns to the delivery reserve, read or estimated, and holds a fee for an open one", () => {
        const debits: Map<string, number | null> = chainDebits();
        debits.set("burn-1", 0.000009);
        debits.set("burn-3", 0); // never landed
        // burn-2 unread: estimated at the ceiling.
        const base = settleDelivery(state(), chainDebits());
        const withBurns = settleDelivery(state({ burns }), debits);
        expect(withBurns.spentSol).toBeCloseTo(base.spentSol + 0.000009 + TX_FEE_SOL, 9);
        expect(withBurns.exact).toBe(false);
        expect(withBurns.heldSol).toBeCloseTo(base.heldSol + TX_FEE_SOL, 9);
    });

    it("charges a delivery attempt that failed on chain once, however many records share it", () => {
        const failed = sends().map((send) => send.signature === "send-5" ? { ...send, failedSignatures: ["send-5-first"] } : send);
        const debits = chainDebits();
        debits.set("send-5-first", 0.000005);
        const base = settleDelivery(state(), chainDebits());
        const withFailed = settleDelivery(state({ sends: failed }), debits);
        expect(withFailed.spentSol).toBeCloseTo(base.spentSol + 0.000005, 9);
    });
});
