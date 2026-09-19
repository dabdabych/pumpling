// tests/unit/orchestrator/batchTransfer.test.ts

import { ComputeBudgetProgram, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import {
    TOKEN_PROGRAM_ID,
    TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";

// Mock connection and spl-token before importing
jest.mock("../../../solana/connection", () => ({
    connection: {
        getAccountInfo: jest.fn(),
    },
}));

const mockHookIx = jest.fn();
const mockFeeHookIx = jest.fn();
jest.mock("@solana/spl-token", () => {
    const actual = jest.requireActual("@solana/spl-token");
    return {
        ...actual,
        getMint: jest.fn(),
        // Hook builders go to the network for the hook program's accounts
        createTransferCheckedWithTransferHookInstruction: (...a: unknown[]) => mockHookIx(...a),
        createTransferCheckedWithFeeAndTransferHookInstruction: (...a: unknown[]) => mockFeeHookIx(...a),
    };
});

const mockInspectMint = jest.fn();
jest.mock("../../../solana/tokenExtensions", () => ({
    inspectMint: (...args: unknown[]) => mockInspectMint(...args),
}));

import { buildBatchSendTransaction, clearCaches } from "../../../orchestrator/batchTransfer";
import { connection } from "../../../solana/connection";
import { getMint } from "@solana/spl-token";

const mockGetAccountInfo = connection.getAccountInfo as jest.Mock;
const mockGetMint = getMint as jest.Mock;

/**
 * The queue payment comes first and exactly once: without it delivery may not
 * make it into a block, and the network rejects duplicate budget instructions outright.
 */
function expectBudgetFirst(tx: { instructions: Array<{ programId: PublicKey; data: Buffer | Uint8Array }> }): void {
    const budget = tx.instructions.filter((ix) => ix.programId.equals(ComputeBudgetProgram.programId));
    expect(budget).toHaveLength(2);
    expect(tx.instructions[0].data[0]).toBe(2);
    expect(tx.instructions[1].data[0]).toBe(3);
}

describe("buildBatchSendTransaction", () => {
    const sender = Keypair.generate();
    const mint = Keypair.generate().publicKey;

    beforeEach(() => {
        clearCaches();
        mockInspectMint.mockResolvedValue({
            blockers: [], warnings: [], transferFeeConfig: null, hasTransferHook: false,
        });

        // Default: classic Token Program
        mockGetAccountInfo.mockResolvedValue({
            owner: TOKEN_PROGRAM_ID,
            data: Buffer.alloc(82),
        });

        mockGetMint.mockResolvedValue({
            decimals: 6,
            isInitialized: true,
        });
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    it("should throw for 0 recipients", async () => {
        await expect(
            buildBatchSendTransaction(mint, [], sender)
        ).rejects.toThrow("No recipients provided");
    });

    it("should throw for more than 5 recipients", async () => {
        const recipients = Array.from({ length: 6 }, () => ({
            wallet: Keypair.generate().publicKey,
            amount: 1000n,
        }));

        await expect(
            buildBatchSendTransaction(mint, recipients, sender)
        ).rejects.toThrow("Too many recipients: 6 (max 5)");
    });

    it("should build transaction for 1 recipient", async () => {
        const recipients = [
            { wallet: Keypair.generate().publicKey, amount: 1000000n },
        ];

        const result = await buildBatchSendTransaction(mint, recipients, sender);

        expect(result.tx).toBeInstanceOf(Transaction);
        expect(result.recipientAtas).toHaveLength(1);
        // 1 createATA + 1 transfer = 2 instructions
        // Two budget instructions plus the ATA creation and the transfer.
        expect(result.tx.instructions).toHaveLength(4);
        expectBudgetFirst(result.tx);
    });

    it("should build transaction for 3 recipients", async () => {
        const recipients = Array.from({ length: 3 }, () => ({
            wallet: Keypair.generate().publicKey,
            amount: 500000n,
        }));

        const result = await buildBatchSendTransaction(mint, recipients, sender);

        expect(result.recipientAtas).toHaveLength(3);
        // 3 * (createATA + transfer) = 6 instructions
        expect(result.tx.instructions).toHaveLength(8);
        expectBudgetFirst(result.tx);
    });

    it("should build transaction for 5 recipients (max batch)", async () => {
        const recipients = Array.from({ length: 5 }, () => ({
            wallet: Keypair.generate().publicKey,
            amount: 200000n,
        }));

        const result = await buildBatchSendTransaction(mint, recipients, sender);

        expect(result.recipientAtas).toHaveLength(5);
        // 5 * (createATA + transfer) = 10 instructions
        expect(result.tx.instructions).toHaveLength(12);
        expectBudgetFirst(result.tx);
    });

    it("should throw if mint not found", async () => {
        mockGetAccountInfo.mockResolvedValue(null);

        const recipients = [
            { wallet: Keypair.generate().publicKey, amount: 1000000n },
        ];

        await expect(
            buildBatchSendTransaction(mint, recipients, sender)
        ).rejects.toThrow("Mint account not found");
    });

    it("should cache token program across calls", async () => {
        const recipients = [
            { wallet: Keypair.generate().publicKey, amount: 1000n },
        ];

        await buildBatchSendTransaction(mint, recipients, sender);
        await buildBatchSendTransaction(mint, recipients, sender);

        // getAccountInfo should be called once (cached)
        expect(mockGetAccountInfo).toHaveBeenCalledTimes(1);
    });

    it("should cache decimals across calls", async () => {
        const recipients = [
            { wallet: Keypair.generate().publicKey, amount: 1000n },
        ];

        await buildBatchSendTransaction(mint, recipients, sender);
        await buildBatchSendTransaction(mint, recipients, sender);

        // getMint should be called once (cached)
        expect(mockGetMint).toHaveBeenCalledTimes(1);
    });
});

describe("Token-2022 extensions at delivery", () => {
    const sender = Keypair.generate();
    const mint = Keypair.generate().publicKey;
    const recipient = Keypair.generate().publicKey;

    beforeEach(() => {
        clearCaches();
        mockGetAccountInfo.mockResolvedValue({
            owner: TOKEN_2022_PROGRAM_ID,
            data: Buffer.alloc(82),
        });
        mockGetMint.mockResolvedValue({ decimals: 6, address: mint });
        mockInspectMint.mockResolvedValue({
            blockers: [], warnings: [], transferFeeConfig: null, hasTransferHook: false,
        });
    });

    it("does not build a transaction for a coin that cannot be delivered", async () => {
        mockInspectMint.mockResolvedValue({
            blockers: ["NonTransferable: transfers are forbidden by the program"],
            warnings: [], transferFeeConfig: null, hasTransferHook: false,
        });
        await expect(
            buildBatchSendTransaction(mint, [{ wallet: recipient, amount: 1000n }], sender)
        ).rejects.toThrow(/cannot be distributed/);
    });

    it("with no extensions, delivered equals sent", async () => {
        const { deliveredAmounts } = await buildBatchSendTransaction(
            mint, [{ wallet: recipient, amount: 1000n }], sender
        );
        expect(deliveredAmounts.map(String)).toEqual(["1000"]);
    });

    it("with a transfer fee, delivered is less than sent", async () => {
        // 300 bps of 1000 is 30, so 970 arrives.
        // The report used to say a thousand, and the deficit calculation in
        // later rounds treated the recipient as better supplied than they were.
        mockInspectMint.mockResolvedValue({
            blockers: [], warnings: [], hasTransferHook: false,
            transferFeeConfig: {
                olderTransferFee: { epoch: 0n, maximumFee: 10n ** 18n, transferFeeBasisPoints: 300 },
                newerTransferFee: { epoch: 0n, maximumFee: 10n ** 18n, transferFeeBasisPoints: 300 },
            },
        });
        (connection as any).getEpochInfo = jest.fn().mockResolvedValue({ epoch: 100 });

        const { deliveredAmounts } = await buildBatchSendTransaction(
            mint, [{ wallet: recipient, amount: 1000n }], sender
        );
        expect(deliveredAmounts.map(String)).toEqual(["970"]);
    });

    it("the fee is worked out per recipient", async () => {
        mockInspectMint.mockResolvedValue({
            blockers: [], warnings: [], hasTransferHook: false,
            transferFeeConfig: {
                olderTransferFee: { epoch: 0n, maximumFee: 10n ** 18n, transferFeeBasisPoints: 300 },
                newerTransferFee: { epoch: 0n, maximumFee: 10n ** 18n, transferFeeBasisPoints: 300 },
            },
        });
        (connection as any).getEpochInfo = jest.fn().mockResolvedValue({ epoch: 100 });

        const { deliveredAmounts } = await buildBatchSendTransaction(
            mint,
            [
                { wallet: recipient, amount: 1000n },
                { wallet: Keypair.generate().publicKey, amount: 2000n },
            ],
            sender
        );
        expect(deliveredAmounts.map(String)).toEqual(["970", "1940"]);
    });
});

describe("picking the transfer instruction by extensions", () => {
    const sender = Keypair.generate();
    const mint = Keypair.generate().publicKey;
    const recipient = Keypair.generate().publicKey;
    const FEE_300 = {
        olderTransferFee: { epoch: 0n, maximumFee: 10n ** 18n, transferFeeBasisPoints: 300 },
        newerTransferFee: { epoch: 0n, maximumFee: 10n ** 18n, transferFeeBasisPoints: 300 },
    };
    // A stub instruction: the contents do not matter, only which builder was called
    const stubIx = () => ({ keys: [], programId: TOKEN_2022_PROGRAM_ID, data: Buffer.alloc(0) });

    beforeEach(() => {
        clearCaches();
        jest.clearAllMocks();
        mockGetAccountInfo.mockResolvedValue({ owner: TOKEN_2022_PROGRAM_ID, data: Buffer.alloc(82) });
        mockGetMint.mockResolvedValue({ decimals: 6, address: mint });
        (connection as any).getEpochInfo = jest.fn().mockResolvedValue({ epoch: 100 });
        mockHookIx.mockResolvedValue(stubIx());
        mockFeeHookIx.mockResolvedValue(stubIx());
    });

    it("a hook without a fee — the builder that resolves the hook accounts", async () => {
        // Without the extra accounts the transfer would fail on chain
        mockInspectMint.mockResolvedValue({
            blockers: [], warnings: [], transferFeeConfig: null, hasTransferHook: true,
        });
        await buildBatchSendTransaction(mint, [{ wallet: recipient, amount: 1000n }], sender);
        expect(mockHookIx).toHaveBeenCalledTimes(1);
        expect(mockFeeHookIx).not.toHaveBeenCalled();
    });

    it("a hook together with a fee — the builder that knows about both", async () => {
        mockInspectMint.mockResolvedValue({
            blockers: [], warnings: [], transferFeeConfig: FEE_300, hasTransferHook: true,
        });
        const { deliveredAmounts } = await buildBatchSendTransaction(
            mint, [{ wallet: recipient, amount: 1000n }], sender
        );
        expect(mockFeeHookIx).toHaveBeenCalledTimes(1);
        expect(mockHookIx).not.toHaveBeenCalled();
        expect(deliveredAmounts.map(String)).toEqual(["970"]);
    });

    it("with no hook the hook builders are not called", async () => {
        mockInspectMint.mockResolvedValue({
            blockers: [], warnings: [], transferFeeConfig: FEE_300, hasTransferHook: false,
        });
        await buildBatchSendTransaction(mint, [{ wallet: recipient, amount: 1000n }], sender);
        expect(mockHookIx).not.toHaveBeenCalled();
        expect(mockFeeHookIx).not.toHaveBeenCalled();
    });
});
