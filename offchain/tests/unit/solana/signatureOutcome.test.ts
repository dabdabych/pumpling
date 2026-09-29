// tests/unit/solana/signatureOutcome.test.ts
//
// "The node has no such signature" means "never arrives" only once the
// transaction's blockhash has expired. Before that, signing a replacement is how
// both land (solana.com/developers/guides/advanced/retry).

import { EXPIRY_MARGIN_BLOCKS, signatureOutcome } from "../../../solana/signatureOutcome";

function node(status: unknown, height = 1_000, calls: string[] = []) {
    return {
        getBlockHeight: jest.fn(async (commitment?: unknown) => {
            calls.push(`height:${String(commitment)}`);
            return height;
        }),
        getSignatureStatus: jest.fn(async (_signature: string, config?: { searchTransactionHistory?: boolean }) => {
            calls.push(`status:${String(config?.searchTransactionHistory)}`);
            if (status instanceof Error) {
                throw status;
            }
            return { context: { slot: 1 }, value: status };
        }),
    };
}

const confirmed = (err: unknown = null, level = "confirmed") => ({ confirmationStatus: level, err, slot: 1, confirmations: 1 });

describe("signatureOutcome", () => {
    it("confirmed or finalized without an error has landed", async () => {
        expect(await signatureOutcome("s", 10, { connection: node(confirmed()) as never })).toBe("landed");
        expect(await signatureOutcome("s", 10, { connection: node(confirmed(null, "finalized")) as never })).toBe("landed");
    });

    it("confirmed with an error ran and failed: its fee was paid, nothing else", async () => {
        expect(await signatureOutcome("s", 10, { connection: node(confirmed({ InstructionError: [0, { Custom: 1 }] })) as never }))
            .toBe("failed");
    });

    it("only processed is not an answer yet", async () => {
        expect(await signatureOutcome("s", 10, { connection: node(confirmed(null, "processed")) as never })).toBe("unknown");
    });

    it("not found while the blockhash may still carry it is unknown, not absent", async () => {
        // lastValidBlockHeight 1000, finalized height exactly at the margin: still unknown.
        const conn = node(null, 1_000 + EXPIRY_MARGIN_BLOCKS);
        expect(await signatureOutcome("s", 1_000, { connection: conn as never })).toBe("unknown");
    });

    it("not found once the chain is past the blockhash and the margin is absent", async () => {
        const conn = node(null, 1_000 + EXPIRY_MARGIN_BLOCKS + 1);
        expect(await signatureOutcome("s", 1_000, { connection: conn as never })).toBe("absent");
    });

    it("reads the finalized height BEFORE the status, and asks for the full history", async () => {
        const calls: string[] = [];
        await signatureOutcome("s", 1_000, { connection: node(null, 5_000, calls) as never });
        expect(calls).toEqual(["height:finalized", "status:true"]);
    });

    it("without the blockhash limit, not found is absent: what every caller did before", async () => {
        const calls: string[] = [];
        expect(await signatureOutcome("s", undefined, { connection: node(null, 0, calls) as never })).toBe("absent");
        expect(calls).toEqual(["status:true"]);
    });

    it("a node that does not answer is unknown, never absent", async () => {
        expect(await signatureOutcome("s", 10, { connection: node(new Error("429")) as never })).toBe("unknown");
        const heightFails = node(null);
        heightFails.getBlockHeight.mockRejectedValueOnce(new Error("timeout"));
        expect(await signatureOutcome("s", 10, { connection: heightFails as never })).toBe("unknown");
    });
});
