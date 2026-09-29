// tests/unit/scripts/reconcileRounds.test.ts
//
// The reconciliation of a round from its transactions, on the numbers of round
// 1790348400190: 29 purchases worth 172,071,643,480,364 raw, five delivery
// transactions worth 161,538,955,135,015, and a purchase that landed after the
// last of them. Its residual is the 10,532,688,345,349 raw found on the keeper.

import { coinSignatures, isStranded, reconcileRound } from "../../../scripts/reconcileRounds";
import { KeeperEffect } from "../../../solana/debits";
import { LotteryState } from "../../../orchestrator/types";

const MINT = "56AsKxgMEVXcXSdqgzHHcPGJ7owdJwzfd9GyRvh8pump";
const BIG = "PrpNxdeSX8SwyUNv4H2pA7aZ6PRYzfAyEPPogCgCDnQ";
const SMALL = "BBAhmonxcKEWaxC5rwDXTLTknS8mqfSPn6asAPaqWpGb";

const PURCHASE_DELTAS = [
    3878138814783n, 3215260623438n, 3668518053694n, 3211194934550n, 3313261421369n, 3026138188790n,
    3337201447703n, 3125957683676n, 3533856083328n, 3212725055098n, 2988953721850n, 3081322931701n,
    3011459871697n, 3216302905243n, 2915026613097n, 3195654900650n, 3159007515607n, 2828413753822n,
    3648367442859n, 12327812211970n, 10530579976079n, 12017715862872n, 11534731955043n, 10396401553484n,
    11518876975420n, 10693662328961n, 10631127070453n, 10532688345348n, 10321285237779n,
];
const DELIVERIES: Array<[string, string, bigint]> = [
    ["d1", BIG, 19437810561362n],
    ["d2", BIG, 18449776960149n],
    ["d3", BIG, 14830097422291n],
    ["d4", BIG, 50610163830283n],
    ["d5", BIG, 51254883412533n],
    ["d5", SMALL, 6956222948397n],
];

function effect(delta: bigint): KeeperEffect {
    return { found: true, debitSol: 0.0001, tokenDeltas: new Map([[MINT, delta]]), failedOnChain: false };
}

function round(): { state: LotteryState; effects: Map<string, KeeperEffect>; loadBatch: () => never } {
    const purchases = PURCHASE_DELTAS.map((_, i) => ({
        index: i + 1, status: "completed", signature: `p${i + 1}`,
        ...(i === 27 ? { pendingSignature: "p28-first" } : {}),
    }));
    const effects = new Map<string, KeeperEffect>();
    PURCHASE_DELTAS.forEach((delta, i) => effects.set(`p${i + 1}`, effect(delta)));
    effects.set("p28-first", { found: false, debitSol: 0, tokenDeltas: new Map(), failedOnChain: false });
    const perTx = new Map<string, bigint>();
    for (const [signature, , amount] of DELIVERIES) {
        perTx.set(signature, (perTx.get(signature) ?? 0n) + amount);
    }
    for (const [signature, amount] of perTx) {
        effects.set(signature, effect(-amount));
    }
    const state = {
        lotteryId: "1790348400190",
        tokenBuys: [{ mint: MINT, adjustedSolAmount: 10.13, status: "completed", batchStateFile: "b.json", updatedAt: 1 }],
        sends: DELIVERIES.map(([signature, recipient, amount], i) => ({
            id: `s${i}`, mint: MINT, recipient, recipientBetSol: 1, share: 0, sendN: 1, round: 1,
            amount: amount.toString(), status: "completed", signature, attempts: 1, updatedAt: 1,
        })),
        summary: {},
    } as unknown as LotteryState;
    const loadBatch = (() => ({ purchases })) as never;
    return { state, effects, loadBatch };
}

describe("reconcileRound", () => {
    it("finds what round 1790348400190 left on the keeper", () => {
        const { state, effects, loadBatch } = round();
        const [row] = reconcileRound(state, loadBatch, effects);
        expect(row.bought).toBe(172_071_643_480_364n);
        expect(row.delivered).toBe(161_538_955_135_015n);
        expect(row.burned).toBe(0n);
        expect(row.residual).toBe(10_532_688_345_349n);
        expect(row.wallets).toBe(2);
        expect(isStranded(row)).toBe(true);
    });

    it("counts a delivery transaction shared by two wallets once", () => {
        const { state, loadBatch } = round();
        expect(coinSignatures(state, MINT, loadBatch).deliveries).toEqual(["d1", "d2", "d3", "d4", "d5"]);
    });

    it("a round whose residual is dust is not called stranded", () => {
        const { state, effects, loadBatch } = round();
        // Suppose the missing tokens had been delivered by the round itself.
        state.sends.push({ ...state.sends[0], id: "late", signature: "d6", amount: "10532688345348" });
        effects.set("d6", effect(-10_532_688_345_348n));
        const [row] = reconcileRound(state, loadBatch, effects);
        expect(row.residual).toBe(1n);
        expect(isStranded(row)).toBe(false);
    });

    it("never calls a round stranded when a transaction could not be read", () => {
        const { state, effects, loadBatch } = round();
        effects.delete("d5");
        const [row] = reconcileRound(state, loadBatch, effects);
        expect(row.unreadTransfers).toBe(1);
        expect(isStranded(row)).toBe(false);
    });

    it("counts burns as tokens that left, and an earlier attempt that landed as bought", () => {
        const { state, effects, loadBatch } = round();
        (state as LotteryState).burns = [
            { id: "b", mint: MINT, rawAmount: "5", status: "completed", signature: "burn", attempts: 1, createdAt: 1, updatedAt: 1 },
        ];
        effects.set("burn", effect(-5n));
        effects.set("p28-first", effect(7n));
        const [row] = reconcileRound(state, loadBatch, effects);
        expect(row.burned).toBe(5n);
        expect(row.bought).toBe(172_071_643_480_371n);
        expect(row.residual).toBe(10_532_688_345_351n);
    });
});
