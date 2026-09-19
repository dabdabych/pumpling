// tests/unit/orchestrator/sendRounds.test.ts

import { Keypair, PublicKey } from "@solana/web3.js";
import {
    calculateSendN,
    assignRounds,
    generateSendRecords,
    calculateDeficitAmounts,
} from "../../../orchestrator/sendRounds";
import { SendRecord } from "../../../orchestrator/types";

// =============================================================================
// calculateSendN
// =============================================================================

describe("calculateSendN", () => {
    it("should return 0 for zero or negative bet", () => {
        expect(calculateSendN(0)).toBe(0);
        expect(calculateSendN(-1)).toBe(0);
    });

    it("should return 1 for bets below 1 SOL", () => {
        expect(calculateSendN(0.01)).toBe(1);
        expect(calculateSendN(0.05)).toBe(1);
        expect(calculateSendN(0.5)).toBe(1);
        expect(calculateSendN(0.99)).toBe(1);
    });

    it("should return 1 at 1 SOL", () => {
        expect(calculateSendN(1)).toBe(1);
    });

    it("should return 3 at 5 SOL", () => {
        expect(calculateSendN(5)).toBe(3);
    });

    it("should return 10 at 20 SOL", () => {
        expect(calculateSendN(20)).toBe(10);
    });

    it("should scale linearly between 1 and 20 SOL", () => {
        expect(calculateSendN(3)).toBe(2);
        expect(calculateSendN(8)).toBe(4);
        expect(calculateSendN(10)).toBe(5);
        expect(calculateSendN(15)).toBe(7);
    });

    it("should return 10 for bet >= 20", () => {
        expect(calculateSendN(20)).toBe(10);
        expect(calculateSendN(50)).toBe(10);
        expect(calculateSendN(100)).toBe(10);
        expect(calculateSendN(1000)).toBe(10);
    });

    it("should be monotonically non-decreasing", () => {
        const values = [0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10, 20, 50, 100];
        for (let i = 1; i < values.length; i++) {
            expect(calculateSendN(values[i])).toBeGreaterThanOrEqual(
                calculateSendN(values[i - 1])
            );
        }
    });
});

// =============================================================================
// assignRounds
// =============================================================================

describe("assignRounds", () => {
    it("should return empty for sendN=0", () => {
        expect(assignRounds(0, 10)).toEqual([]);
    });

    it("should return last round for sendN=1", () => {
        expect(assignRounds(1, 10)).toEqual([10]);
    });

    it("should spread sendN=4 across 10 rounds", () => {
        // step=2.5 → ceil(2.5)=3, ceil(5)=5, ceil(7.5)=8, ceil(10)=10
        expect(assignRounds(4, 10)).toEqual([3, 5, 8, 10]);
    });

    it("should return all rounds when sendN=totalRounds", () => {
        expect(assignRounds(10, 10)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    });

    it("should handle sendN > totalRounds (cap)", () => {
        expect(assignRounds(15, 10)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    });

    it("should always end with the last round", () => {
        for (let n = 1; n <= 10; n++) {
            const rounds = assignRounds(n, 10);
            expect(rounds[rounds.length - 1]).toBe(10);
        }
    });

    it("should be monotonically increasing", () => {
        for (let n = 1; n <= 10; n++) {
            const rounds = assignRounds(n, 10);
            for (let i = 1; i < rounds.length; i++) {
                expect(rounds[i]).toBeGreaterThan(rounds[i - 1]);
            }
        }
    });

    it("should spread sendN=2 across 10 rounds", () => {
        // step=5 → ceil(5)=5, ceil(10)=10
        expect(assignRounds(2, 10)).toEqual([5, 10]);
    });

    it("should spread sendN=3 across 10 rounds", () => {
        // step=3.33 → ceil(3.33)=4, ceil(6.67)=7, ceil(10)=10
        expect(assignRounds(3, 10)).toEqual([4, 7, 10]);
    });
});

// =============================================================================
// generateSendRecords
// =============================================================================

describe("generateSendRecords", () => {
    const mint1 = Keypair.generate().publicKey;
    const r1 = Keypair.generate().publicKey;
    const r2 = Keypair.generate().publicKey;

    it("should return empty for no tokens", () => {
        expect(generateSendRecords([])).toEqual([]);
    });

    it("should generate 1 record for sendN=1 in last round", () => {
        const records = generateSendRecords([
            {
                mint: mint1,
                recipients: [{ publickey: r1, amount: 0.05 }],
            },
        ], 10);

        expect(records).toHaveLength(1);
        expect(records[0].round).toBe(10); // last round
        expect(records[0].sendN).toBe(1);
        expect(records[0].share).toBe(1);
        expect(records[0].status).toBe("pending");
    });

    it("should generate K records with spread rounds", () => {
        const records = generateSendRecords([
            {
                mint: mint1,
                recipients: [{ publickey: r1, amount: 10 }], // sendN=5
            },
        ], 10);

        const sendN = calculateSendN(10); // 5
        expect(records).toHaveLength(sendN);

        // Rounds should be spread, not sequential 1..K
        const rounds = records.map((r) => r.round);
        expect(rounds[rounds.length - 1]).toBe(10); // ends at last round
        // Monotonically increasing
        for (let i = 1; i < rounds.length; i++) {
            expect(rounds[i]).toBeGreaterThan(rounds[i - 1]);
        }
    });

    it("should calculate share correctly for multiple recipients", () => {
        const records = generateSendRecords([
            {
                mint: mint1,
                recipients: [
                    { publickey: r1, amount: 10 },
                    { publickey: r2, amount: 5 },
                ],
            },
        ]);

        const r1Records = records.filter((r) => r.recipient === r1.toBase58());
        const r2Records = records.filter((r) => r.recipient === r2.toBase58());

        expect(r1Records[0].share).toBeCloseTo(10 / 15, 10);
        expect(r2Records[0].share).toBeCloseTo(5 / 15, 10);
    });

    it("should have unique IDs across all records", () => {
        const records = generateSendRecords([
            {
                mint: mint1,
                recipients: [
                    { publickey: r1, amount: 10 },
                    { publickey: r2, amount: 5 },
                ],
            },
        ]);

        const ids = records.map((r) => r.id);
        expect(new Set(ids).size).toBe(ids.length);
    });
});

// =============================================================================
// calculateDeficitAmounts
// =============================================================================

describe("calculateDeficitAmounts", () => {
    // New code uses recipientBetSol (BigInt lamports) for target calculation,
    // NOT share. Tests must have consistent recipientBetSol values.
    function makeSend(
        id: string,
        recipientBetSol: number,
        sendN: number,
        overrides: Partial<SendRecord> = {}
    ): SendRecord {
        return {
            id,
            mint: "mint1",
            recipient: "rec1",
            recipientBetSol,
            share: 0, // not used by calculateDeficitAmounts
            sendN,
            round: 1,
            status: "pending",
            attempts: 0,
            updatedAt: 0,
            ...overrides,
        };
    }

    it("should return empty map for no sends", () => {
        const result = calculateDeficitAmounts([], [], 1000n);
        expect(result.size).toBe(0);
    });

    it("should return empty map for zero balance", () => {
        const sends = [makeSend("s1", 5, 1)];
        const result = calculateDeficitAmounts(sends, sends, 0n);
        expect(result.size).toBe(0);
    });

    it("should give all to single recipient (nothing sent yet)", () => {
        const sends = [makeSend("s1", 10, 1)];
        const result = calculateDeficitAmounts(sends, sends, 1000n);
        expect(result.get("s1")).toBe(1000n);
    });

    it("should split proportionally between two recipients", () => {
        // rec1 bet=6, rec2 bet=4, total=10 → 60/40 split
        const sends = [
            makeSend("s1", 6, 1, { recipient: "rec1" }),
            makeSend("s2", 4, 1, { recipient: "rec2" }),
        ];
        const result = calculateDeficitAmounts(sends, sends, 1000n);
        expect(result.get("s1")).toBe(600n);
        expect(result.get("s2")).toBe(400n);
    });

    it("should account for already-sent tokens", () => {
        // rec1 bet=6, rec2 bet=4 → 60/40
        // rec1 already received 300 tokens
        // balance=700, totalTokens=700+300=1000
        // rec1 target=600, deficit=300
        // rec2 target=400, deficit=400
        const completedSend = makeSend("s0", 6, 2, {
            recipient: "rec1",
            status: "completed",
            amount: "300",
        });
        const active1 = makeSend("s1", 6, 2, { recipient: "rec1", round: 2 });
        const active2 = makeSend("s2", 4, 1, { recipient: "rec2" });

        const allSends = [completedSend, active1, active2];
        const activeSends = [active1, active2];

        const result = calculateDeficitAmounts(activeSends, allSends, 700n);
        expect(result.get("s1")).toBe(300n);
        expect(result.get("s2")).toBe(400n);
    });

    it("should maintain proportions with different sendN", () => {
        // A bet=952, B bet=48, total=1000 → A=95.2%, B=4.8%
        // Round with only A active, balance=200
        // A target = (200 * 952) / 1000 = 190, deficit = 190
        // A gets 190, leaving 10 for B's future round
        const sendA = makeSend("sA", 952, 5, { recipient: "recA" });
        const allSends = [
            sendA,
            makeSend("sB", 48, 1, { recipient: "recB", round: 10 }),
        ];

        const result = calculateDeficitAmounts([sendA], allSends, 200n);
        expect(result.get("sA")).toBe(190n);
    });

    it("should leave proportional remainder for inactive recipients", () => {
        // A bet=952, B bet=48. A already sent 761 in rounds 1-4.
        // balance=239, totalTokens=1000
        // A target=952, sent=761, deficit=191
        // B target=48, sent=0, deficit=48
        // totalDeficit=239 = balance → exact fit
        const sendA_r5 = makeSend("sA5", 952, 5, { recipient: "recA", round: 5 });
        const sendB_r5 = makeSend("sB1", 48, 1, { recipient: "recB", round: 5 });

        const completedSends = [
            makeSend("sA1", 952, 5, { recipient: "recA", round: 1, status: "completed", amount: "190" }),
            makeSend("sA2", 952, 5, { recipient: "recA", round: 2, status: "completed", amount: "190" }),
            makeSend("sA3", 952, 5, { recipient: "recA", round: 3, status: "completed", amount: "191" }),
            makeSend("sA4", 952, 5, { recipient: "recA", round: 4, status: "completed", amount: "190" }),
        ];

        const allSends = [...completedSends, sendA_r5, sendB_r5];
        const result = calculateDeficitAmounts([sendA_r5, sendB_r5], allSends, 239n);

        const aAmount = result.get("sA5")!;
        const bAmount = result.get("sB1")!;

        expect(aAmount).toBe(191n);
        expect(bAmount).toBe(48n);
        expect(aAmount + bAmount).toBe(239n);
    });

    it("should scale down when deficit exceeds balance", () => {
        // rec1 bet=6, rec2 bet=4 → 60/40
        // balance=100, totalTokens=100
        // rec1 target=60, rec2 target=40, totalDeficit=100 = balance
        const sends = [
            makeSend("s1", 6, 1, { recipient: "rec1" }),
            makeSend("s2", 4, 1, { recipient: "rec2" }),
        ];
        const result = calculateDeficitAmounts(sends, sends, 100n);
        expect(result.get("s1")).toBe(60n);
        expect(result.get("s2")).toBe(40n);
    });

    it("should handle zero deficit (recipient already has enough)", () => {
        // rec1 bet=5, rec2 bet=5 → 50/50
        // rec1 already received 600 (more than target 500)
        // balance=400, totalTokens=1000
        // rec1 deficit=0, rec2 deficit=500 > balance → gets 400
        const completed = makeSend("s0", 5, 1, {
            recipient: "rec1",
            status: "completed",
            amount: "600",
        });
        const active1 = makeSend("s1", 5, 2, { recipient: "rec1", round: 2 });
        const active2 = makeSend("s2", 5, 1, { recipient: "rec2" });

        const result = calculateDeficitAmounts(
            [active1, active2],
            [completed, active1, active2],
            400n
        );
        expect(result.has("s1")).toBe(false);
        expect(result.get("s2")).toBe(400n);
    });

    it("should split evenly among multiple active sends for same recipient", () => {
        const send1 = makeSend("s1", 10, 2, { recipient: "rec1", round: 1 });
        const send2 = makeSend("s2", 10, 2, { recipient: "rec1", round: 2 });

        const result = calculateDeficitAmounts([send1, send2], [send1, send2], 1000n);
        expect(result.get("s1")).toBe(500n);
        expect(result.get("s2")).toBe(500n);
    });

    it("should not count failed sends as already sent", () => {
        const failedSend = makeSend("s0", 10, 2, {
            recipient: "rec1",
            status: "failed",
            amount: "500",
        });
        const activeSend = makeSend("s1", 10, 2, { recipient: "rec1", round: 2 });

        const result = calculateDeficitAmounts(
            [activeSend],
            [failedSend, activeSend],
            1000n
        );
        expect(result.get("s1")).toBe(1000n);
    });
});

describe("an oversized transaction is cured by splitting the batch", () => {
    // A hook adds accounts to every transfer, and five recipients stop fitting
    // into 1232 bytes. tx.serialize() throws that locally, before the network.
    // The message used to match no pattern at all: unknown -> three useless
    // retries -> abandoned.
    const { classifyError } = jest.requireActual("../../../scheduler/errors");

    it("such an error does not count as unknown", () => {
        // Before the fix the predicate only looked at ComputeBudget and
        // variations of "compute units exceeded", and transaction size was not among them.
        const tooLarge = new Error("Transaction too large: 1318 > 1232");
        expect(classifyError(tooLarge).errorClass).not.toBe("non-retryable");
    });
});
