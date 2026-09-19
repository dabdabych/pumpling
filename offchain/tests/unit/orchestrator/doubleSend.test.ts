// tests/unit/orchestrator/doubleSend.test.ts
//
// A regression from the PR #28 review. The delivery went out, we never got the
// confirmation (`block height exceeded`, retryable), and it was sent again. The
// recipient got their share twice while the others came up short out of the
// same remainder: `calculateDeficitAmounts` only counts `completed`, and a
// delivery that arrived without confirming was invisible — even though the
// tokens had already left the keeper.
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

jest.mock("../../../solana/connection", () => ({
    connection: {
        getAccountInfo: jest.fn().mockResolvedValue(null),
        getTokenAccountBalance: jest.fn(),
        // Needed by the fix: before a repeat it establishes the signature's fate
        getSignatureStatus: jest.fn(),
    },
}));

jest.mock("../../../solana/transaction", () => ({
    // A real PostSendError: the fix uses it to tell "it went out" from "it was
    // never sent", so it cannot be replaced with a stub.
    ...jest.requireActual("../../../solana/transaction"),
    sendTransaction: jest.fn(),
}));

const mockBuild = jest.fn();
jest.mock("../../../orchestrator/batchTransfer", () => ({
    detectTokenProgram: jest.fn().mockResolvedValue(
        new (require("@solana/web3.js").PublicKey)("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")
    ),
    buildBatchSendTransaction: (...a: unknown[]) => mockBuild(...a),
}));

import { executeSendRounds } from "../../../orchestrator/sendRounds";
import { OrchestratorStateManager } from "../../../orchestrator/state";
import { connection } from "../../../solana/connection";
import { sendTransaction } from "../../../solana/transaction";
import { LotteryState, SendRecord } from "../../../orchestrator/types";

const mockBalance = connection.getTokenAccountBalance as jest.Mock;
const mockSigStatus = connection.getSignatureStatus as jest.Mock;
const mockSend = sendTransaction as jest.Mock;

it("a delivery that arrived does not go out twice, and the shares stay equal", async () => {
    const keeper = Keypair.generate();
    const mint = Keypair.generate().publicKey;
    const A = Keypair.generate().publicKey.toBase58();
    const B = Keypair.generate().publicKey.toBase58();

    const send = (id: string, recipient: string, round: number): SendRecord => ({
        id, mint: mint.toBase58(), recipient, recipientBetSol: 1,
        share: 0.5, sendN: 1, round, status: "pending", attempts: 0,
        updatedAt: Date.now(),
    });

    const state: LotteryState = {
        lotteryId: "repro", totalSol: 2, sendReserve: 0, buyBudget: 2,
        config: {} as LotteryState["config"],
        tokenBuys: [],
        sends: [send("a1", A, 1), send("b1", B, 2)],
        summary: {} as LotteryState["summary"],
    };
    const stateManager = OrchestratorStateManager.create(
        state, path.join(fs.mkdtempSync(path.join(os.tmpdir(), "repro-")), "s.json")
    );

    // The keeper balance: 1000 before the first delivery, 500 after — the transaction ARRIVED.
    let landed = false;
    mockBalance.mockImplementation(async () => ({
        value: { amount: landed ? "500" : "1000" },
    }));

    const delivered: Array<{ recipient: string; amount: bigint }> = [];
    mockBuild.mockImplementation(async (_m, recipients: Array<{ wallet: PublicKey; amount: bigint }>) => ({
        tx: new Transaction(),
        recipientAtas: [],
        deliveredAmounts: recipients.map((r) => r.amount),
        __recipients: recipients,
    }));

    // The transaction arrived and executed, and the status confirms it
    mockSigStatus.mockResolvedValue({
        value: { confirmationStatus: "finalized", err: null },
    });

    mockSend.mockImplementation(async () => {
        const call = mockBuild.mock.results[mockBuild.mock.results.length - 1];
        const built = await call.value;
        for (const r of built.__recipients) {
            delivered.push({ recipient: r.wallet.toBase58(), amount: r.amount });
        }
        if (!landed) {
            // The transaction went out and executed, but the confirmation expired.
            landed = true;
            const { PostSendError } = jest.requireActual("../../../solana/transaction");
            throw new PostSendError(
                "Transaction send/confirm failed: TransactionExpiredBlockheightExceededError: block height exceeded.",
                "sig-landed"
            );
        }
        return "sig-ok";
    });

    await executeSendRounds({
        keeper, stateManager, totalRounds: 2, intervalMs: 0,
        sendConcurrency: 5, startTime: Date.now() - 1,
    });

    const perRecipient = new Map<string, bigint>();
    for (const d of delivered) {
        perRecipient.set(d.recipient, (perRecipient.get(d.recipient) ?? 0n) + d.amount);
    }

    // The commits are equal, so the shares must be equal.
    console.log("Actually delivered:", {
        A: String(perRecipient.get(A) ?? 0n), B: String(perRecipient.get(B) ?? 0n),
    });
    console.log("Times sent to A:", delivered.filter((d) => d.recipient === A).length);
    expect(String(perRecipient.get(A) ?? 0n)).toBe(String(perRecipient.get(B) ?? 0n));
});
