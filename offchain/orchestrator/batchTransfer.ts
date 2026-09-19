// orchestrator/batchTransfer.ts
// Batch send — up to 5 recipients in one transaction

import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import {
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
    getMint,
    getAssociatedTokenAddressSync,
    createAssociatedTokenAccountIdempotentInstruction,
    createTransferCheckedInstruction,
    createTransferCheckedWithFeeInstruction,
    createTransferCheckedWithTransferHookInstruction,
    createTransferCheckedWithFeeAndTransferHookInstruction,
    calculateEpochFee,
} from "@solana/spl-token";
import { budgetInstructions, deliveryComputeUnits } from "../solana/priorityFee";
import { connection } from "../solana/connection";
import { inspectMint } from "../solana/tokenExtensions";

// =============================================================================
// CACHE
// =============================================================================

const tokenProgramCache = new Map<string, PublicKey>();
const decimalsCache = new Map<string, number>();

/**
 * Works out the token program for a mint (cached).
 */
export async function detectTokenProgram(mint: PublicKey): Promise<PublicKey> {
    const key = mint.toBase58();
    const cached = tokenProgramCache.get(key);
    if (cached) return cached;

    const info = await connection.getAccountInfo(mint);
    if (!info) throw new Error(`Mint account not found: ${key}`);

    tokenProgramCache.set(key, info.owner);
    return info.owner;
}

/**
 * Reads the decimals for a mint (cached).
 */
export async function getMintDecimals(
    mint: PublicKey,
    tokenProgramId: PublicKey
): Promise<number> {
    const key = mint.toBase58();
    const cached = decimalsCache.get(key);
    if (cached !== undefined) return cached;

    const mintData = await getMint(connection, mint, "confirmed", tokenProgramId);
    decimalsCache.set(key, mintData.decimals);
    return mintData.decimals;
}

// =============================================================================
// BUILD BATCH SEND TRANSACTION
// =============================================================================

/**
 * The current epoch number, with a short cache.
 *
 * An epoch lasts about two days, so a minute of staleness is safe. Only needed
 * for mints with a transfer fee.
 */
const EPOCH_CACHE_TTL_MS = 60 * 1000;
let epochCache: { at: number; epoch: bigint } | null = null;

async function currentEpoch(): Promise<bigint> {
    if (epochCache && Date.now() - epochCache.at < EPOCH_CACHE_TTL_MS) {
        return epochCache.epoch;
    }
    const epoch = BigInt((await connection.getEpochInfo()).epoch);
    epochCache = { at: Date.now(), epoch };
    return epoch;
}

export interface BatchRecipient {
    wallet: PublicKey;
    amount: bigint;
}

export interface BatchSendResult {
    tx: Transaction;
    recipientAtas: PublicKey[];
    /**
     * How many tokens will ARRIVE for each recipient, in `recipients` order.
     *
     * The same as requested for ordinary coins, but less for a mint with a
     * transfer fee: the fee is withheld on the recipient's account and is not
     * available to them. This is the number that belongs in the report,
     * otherwise the record of what was delivered diverges from what the person
     * actually received.
     */
    deliveredAmounts: bigint[];
}

/**
 * Builds a transaction that sends tokens to several recipients (up to 5).
 *
 * For each recipient:
 *
 * @param mint - the token address
 * @param recipients - the recipients (wallet + amount), up to 5
 * @param sender - the sender's keypair
 * @returns the transaction and the recipients' ATAs
 */
export async function buildBatchSendTransaction(
    mint: PublicKey,
    recipients: BatchRecipient[],
    sender: Keypair
): Promise<BatchSendResult> {
    if (recipients.length === 0) {
        throw new Error("No recipients provided");
    }
    if (recipients.length > 5) {
        throw new Error(`Too many recipients: ${recipients.length} (max 5)`);
    }

    const tokenProgramId = await detectTokenProgram(mint);
    const decimals = await getMintDecimals(mint, tokenProgramId);
    const report = await inspectMint(mint);

    // Such a coin cannot be delivered at all. The check also runs before
    // buying, but here it is the last one: better not to send than to send into
    // the void.
    if (report.blockers.length) {
        throw new Error(
            `Mint cannot be distributed: ${report.blockers.join("; ")}`
        );
    }

    // The fee rate depends on the epoch: the extension holds two records, old
    // and new, and the one whose epoch has arrived applies. The epoch number is
    // cached — delivery goes in batches of five recipients, and without the
    // cache one round for fifty people would cost a dozen identical requests.
    const epoch = report.transferFeeConfig ? await currentEpoch() : 0n;

    const senderAta = getAssociatedTokenAddressSync(
        mint,
        sender.publicKey,
        false,
        tokenProgramId,
        ASSOCIATED_TOKEN_PROGRAM_ID
    );

    const tx = new Transaction();
    const recipientAtas: PublicKey[] = [];
    const deliveredAmounts: bigint[] = [];

    for (const r of recipients) {
        const recipientAta = getAssociatedTokenAddressSync(
            mint,
            r.wallet,
            false,
            tokenProgramId,
            ASSOCIATED_TOKEN_PROGRAM_ID
        );
        recipientAtas.push(recipientAta);

        tx.add(
            createAssociatedTokenAccountIdempotentInstruction(
                sender.publicKey,
                recipientAta,
                r.wallet,
                mint,
                tokenProgramId,
                ASSOCIATED_TOKEN_PROGRAM_ID
            )
        );

        const fee = report.transferFeeConfig
            ? calculateEpochFee(report.transferFeeConfig, epoch, r.amount)
            : 0n;
        deliveredAmounts.push(r.amount - fee);

        // Which instruction to use, by the mint's extensions:
        //   hook — the extra accounts are mandatory, otherwise the transfer
        //          fails on chain; the builder reads them from the hook
        //          program's PDA;
        //   fee  — the WithFee variant compares the expected fee with the
        //          actual one and refuses if the rate changed between the
        //          calculation and execution. A plain transferChecked would
        //          also go through, but would quietly withhold a different amount.
        if (report.hasTransferHook && report.transferFeeConfig) {
            tx.add(
                await createTransferCheckedWithFeeAndTransferHookInstruction(
                    connection, senderAta, mint, recipientAta, sender.publicKey,
                    r.amount, decimals, fee, [], "confirmed", tokenProgramId
                )
            );
        } else if (report.hasTransferHook) {
            tx.add(
                await createTransferCheckedWithTransferHookInstruction(
                    connection, senderAta, mint, recipientAta, sender.publicKey,
                    r.amount, decimals, [], "confirmed", tokenProgramId
                )
            );
        } else if (report.transferFeeConfig) {
            tx.add(
                createTransferCheckedWithFeeInstruction(
                    senderAta, mint, recipientAta, sender.publicKey,
                    r.amount, decimals, fee, [], tokenProgramId
                )
            );
        } else {
            tx.add(
                createTransferCheckedInstruction(
                    senderAta, mint, recipientAta, sender.publicKey,
                    r.amount, decimals, [], tokenProgramId
                )
            );
        }
    }

    // Paying for queue position. The compute limit is worked out from the
    // number of recipients: each one has their own ATA creation and their own
    // transfer. Measured from our history at up to 116,620 units per batch, so
    // the headroom is doubled.
    const budget = await budgetInstructions(
        "delivery",
        deliveryComputeUnits(recipients.length),
        [sender.publicKey, senderAta]
    );
    // The budget has to come first and the transfer instructions are already
    // assembled, so we rebuild the transaction in the right order.
    const ordered = new Transaction().add(...budget).add(...tx.instructions);

    return { tx: ordered, recipientAtas, deliveredAmounts };
}

/**
 * Clears the caches (for tests).
 */
export function clearCaches(): void {
    epochCache = null;
    tokenProgramCache.clear();
    decimalsCache.clear();
}
