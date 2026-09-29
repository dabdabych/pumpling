// tests/unit/orchestrator/shares.test.ts
//
// Who gets what of a coin's tokens. The end-to-end promise is checked in
// `burnDelivery.test.ts`; these are the pieces it rests on.

import {
    averageBurnBps, burnOwed, burnWeightOf, deliveryOwed, hasBurn, sharesOf, totalStake,
} from "../../../orchestrator/shares";
import { LotteryState, RecipientStake } from "../../../orchestrator/types";

const MINT = "MintAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

function stateWith(recipients: RecipientStake[] | undefined, sends: LotteryState["sends"] = []): LotteryState {
    return {
        lotteryId: "t", totalSol: 1, sendReserve: 0, buyBudget: 1,
        config: {} as LotteryState["config"],
        tokenBuys: [{ mint: MINT, adjustedSolAmount: 1, status: "pending", recipients, updatedAt: 1 }],
        sends,
        summary: {} as LotteryState["summary"],
    };
}

describe("burnWeightOf", () => {
    it("takes the exact weight when there is one", () => {
        expect(burnWeightOf(3n, "12345", 0)).toBe(12345n);
    });
    it("falls back to the commit times its basis points", () => {
        expect(burnWeightOf(1_000n, undefined, 2500)).toBe(2_500_000n);
        expect(burnWeightOf(1_000n, undefined, 2500.4)).toBe(2_500_000n);
    });
    it("never goes below nothing or above all of the commit", () => {
        expect(burnWeightOf(1_000n, "99999999", 0)).toBe(10_000_000n);
        expect(burnWeightOf(1_000n, undefined, -5)).toBe(0n);
        expect(burnWeightOf(1_000n, undefined, 20_000)).toBe(10_000_000n);
        expect(burnWeightOf(1_000n, "-3", 0)).toBe(0n);
        expect(burnWeightOf(1_000n, undefined, Number.NaN)).toBe(0n);
    });
});

describe("sharesOf", () => {
    it("a wallet listed twice is one wallet: commits and burn weights add up exactly", () => {
        const shares = sharesOf(stateWith([
            { wallet: "A", stakeLamports: "1000000000", burnBps: 0, burnWeight: "0" },
            { wallet: "A", stakeLamports: "2000000000", burnBps: 5000, burnWeight: "10000000000000" },
            { wallet: "B", stakeLamports: "3000000000", burnBps: 0, burnWeight: "0" },
        ]), MINT);
        expect(shares).toEqual([
            { wallet: "A", stake: 3_000_000_000n, burn: 10_000_000_000_000n },
            { wallet: "B", stake: 3_000_000_000n, burn: 0n },
        ]);
        // Two commits of A, 1 SOL at 0% and 2 SOL at 50%: A gets exactly
        // 1/6 + 1/6 of B, not an averaged 3333 bps rounded.
        expect(deliveryOwed(6_000n, "A", shares)).toBe(2_000n);
        expect(burnOwed(6_000n, shares)).toBe(1_000n);
        expect(averageBurnBps(shares)).toBeCloseTo(1666.66, 2);
    });

    it("a round from before the burn existed is read from its deliveries, and nobody burns", () => {
        const send = (recipient: string, sol: number, id: string) => ({
            id, mint: MINT, recipient, recipientBetSol: sol, share: 0, sendN: 1, round: 1,
            status: "completed" as const, attempts: 1, updatedAt: 1,
        });
        const shares = sharesOf(stateWith(undefined, [send("A", 1, "1"), send("A", 1, "2"), send("B", 0.5, "3")]), MINT);
        expect(shares).toEqual([
            { wallet: "A", stake: 1_000_000_000n, burn: 0n },
            { wallet: "B", stake: 500_000_000n, burn: 0n },
        ]);
        expect(hasBurn(shares)).toBe(false);
    });

    it("leaves out a commit of nothing and a malformed amount", () => {
        const shares = sharesOf(stateWith([
            { wallet: "A", stakeLamports: "0", burnBps: 10_000 },
            { wallet: "B", stakeLamports: "abc", burnBps: 10_000 },
            { wallet: "C", stakeLamports: "5", burnBps: 0 },
        ]), MINT);
        expect(shares.map((share) => share.wallet)).toEqual(["C"]);
        expect(totalStake(shares)).toBe(5n);
    });
});

describe("the arithmetic", () => {
    const shares = [
        { wallet: "A", stake: 7n, burn: 7n * 10_000n },
        { wallet: "B", stake: 13n, burn: 0n },
    ];
    it("rounds every share down, so what is owed never exceeds what was bought", () => {
        for (const bought of [0n, 1n, 19n, 20n, 1_000_003n, 123_456_789_012_345n]) {
            const sum = burnOwed(bought, shares) + deliveryOwed(bought, "A", shares) + deliveryOwed(bought, "B", shares);
            expect(sum).toBeLessThanOrEqual(bought);
            expect(bought - sum).toBeLessThanOrEqual(2n);
        }
    });
    it("someone not behind the coin is owed nothing", () => {
        expect(deliveryOwed(1_000n, "Z", shares)).toBe(0n);
        expect(burnOwed(1_000n, [])).toBe(0n);
    });
});
