// src/send.ts
// Sending SPL tokens to the wallets that backed a coin

import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import {
    TOKEN_2022_PROGRAM_ID,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
    getMint,
    getAssociatedTokenAddressSync,
    createAssociatedTokenAccountIdempotentInstruction,
    createTransferCheckedInstruction,
} from "@solana/spl-token";
import { connection } from "./solana/connection";
import { sendTransaction } from "./solana/transaction";
import { budgetInstructions, deliveryComputeUnits } from "./solana/priorityFee";
import { logger as rootLogger, Logger } from "./logger";

// =============================================================================
// TYPES
// =============================================================================

export interface SendResult {
    signature: string;
    recipientAta: PublicKey;
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Works out the token program for a mint.
 * Returns TOKEN_2022_PROGRAM_ID or TOKEN_PROGRAM_ID.
 */
async function detectTokenProgram(mint: PublicKey): Promise<PublicKey> {
    const mintInfo = await connection.getAccountInfo(mint);
    if (!mintInfo) {
        throw new Error(`Mint account not found: ${mint.toBase58()}`);
    }
    return mintInfo.owner;
}

/**
 * Reads the decimals of a token.
 */
async function getMintDecimals(
    mint: PublicKey,
    tokenProgramId: PublicKey
): Promise<number> {
    const mintData = await getMint(connection, mint, "confirmed", tokenProgramId);
    return mintData.decimals;
}

// =============================================================================
// BUILD TRANSACTION
// =============================================================================

/**
 * Builds the transaction that sends tokens.
 *
 * @param mint - the token address
 * @param recipient - the recipient's wallet address (NOT their ATA)
 * @param amount - the amount in raw units (1_000_000 = 1 token at 6 decimals)
 * @param sender - the sender's keypair
 * @returns the transaction and the recipient's ATA
 */
export async function buildSendTransaction(
    mint: PublicKey,
    recipient: PublicKey,
    amount: bigint | number,
    sender: Keypair
): Promise<{ tx: Transaction; recipientAta: PublicKey; decimals: number }> {
    // 1. Work out the token program
    const tokenProgramId = await detectTokenProgram(mint);
    const isToken2022 = tokenProgramId.equals(TOKEN_2022_PROGRAM_ID);

    // 2. Read the decimals
    const decimals = await getMintDecimals(mint, tokenProgramId);

    // 3. Derive the ATA addresses
    const senderAta = getAssociatedTokenAddressSync(
        mint,
        sender.publicKey,
        false, // allowOwnerOffCurve
        tokenProgramId,
        ASSOCIATED_TOKEN_PROGRAM_ID
    );

    const recipientAta = getAssociatedTokenAddressSync(
        mint,
        recipient,
        false, // allowOwnerOffCurve
        tokenProgramId,
        ASSOCIATED_TOKEN_PROGRAM_ID
    );

    // 4. Build the instruction that creates the recipient's ATA (idempotent)
    const createAtaIx = createAssociatedTokenAccountIdempotentInstruction(
        sender.publicKey, // payer
        recipientAta, // ata
        recipient, // owner
        mint, // mint
        tokenProgramId, // token program
        ASSOCIATED_TOKEN_PROGRAM_ID // associated token program
    );

    // 5. Build the transfer instruction
    const amountBigInt = typeof amount === "number" ? BigInt(amount) : amount;

    const transferIx = createTransferCheckedInstruction(
        senderAta, // source
        mint, // mint
        recipientAta, // destination
        sender.publicKey, // owner
        amountBigInt, // amount
        decimals, // decimals
        [], // multiSigners
        tokenProgramId // programId
    );

    // 6. Paying for queue position: delivery overtakes nobody, but there is no
    //    reason for it to sit waiting for a block either. The ceiling is token,
    //    and the same amount is reserved in the delivery fee calculation.
    const budget = await budgetInstructions(
        "delivery",
        deliveryComputeUnits(1),
        [sender.publicKey, recipientAta]
    );

    // 7. Assemble the transaction
    const tx = new Transaction().add(...budget).add(createAtaIx).add(transferIx);

    return { tx, recipientAta, decimals };
}

// =============================================================================
// MAIN FUNCTION
// =============================================================================

/**
 * Sends SPL tokens to a recipient.
 * Creates the recipient's ATA automatically if it does not exist.
 * Supports Token-2022 and the classic token program.
 *
 * @param mint - the token address
 * @param recipient - the recipient's wallet address (NOT their ATA)
 * @param amount - the amount in raw units (1_000_000 = 1 token at 6 decimals)
 * @param sender - the sender's keypair
 * @returns the transaction signature and the recipient's ATA
 *
 * @example
 * ```typescript
 * // Send 1 token (at 6 decimals) to a recipient
 * const result = await send(
 *     tokenMint,
 *     winnerWallet,
 *     1_000_000n,    // 1 token = 1_000_000 raw units
 *     keeper
 * );
 * console.log(`Sent! TX: ${result.signature}`);
 * ```
 */
export async function send(
    mint: PublicKey,
    recipient: PublicKey,
    amount: bigint | number,
    sender: Keypair,
    log?: Logger
): Promise<SendResult> {
    const l = log || rootLogger;

    l.info({
        event: "send.start",
        mint: mint.toBase58().slice(0, 8),
        recipient: recipient.toBase58().slice(0, 8),
        amount: String(amount),
    }, "Sending tokens");

    // Build the transaction
    const { tx, recipientAta } = await buildSendTransaction(
        mint,
        recipient,
        amount,
        sender
    );

    // Send it
    const signature = await sendTransaction(tx, sender);

    l.info({
        event: "send.completed",
        mint: mint.toBase58().slice(0, 8),
        signature: signature.slice(0, 16),
    }, "Tokens sent");

    return { signature, recipientAta };
}
