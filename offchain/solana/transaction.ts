// src/solana/transaction.ts
// Generic transaction helpers

import { Transaction, Keypair, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { connection, sendTxLimiter } from "./connection";

// =============================================================================
// POST-SEND ERROR
// =============================================================================

/**
 * An error after crossing into the post-send stage.
 * The tx may have reached the mempool; the signature lets the scheduler check
 * its status before a retry and avoid a double buy.
 */
export class PostSendError extends Error {
    constructor(
        message: string,
        public readonly signature?: string,
        public readonly cause?: unknown,
        /**
         * The last block height at which the transaction can still land. Until
         * the chain is past it, "not found" does not mean "never arrives", and
         * signing a replacement risks both landing (see `signatureOutcome`).
         */
        public readonly lastValidBlockHeight?: number,
    ) {
        super(message);
        this.name = "PostSendError";
    }
}

export function getSignedTransactionSignature(
    tx: Transaction | VersionedTransaction
): string | undefined {
    if (tx instanceof VersionedTransaction) {
        const signature = tx.signatures[0];
        return signature ? bs58.encode(signature) : undefined;
    }
    return tx.signature ? bs58.encode(tx.signature) : undefined;
}

/** The venue an error came from. */
export type ErrorVenue = "pumpfun" | "dex" | "pumpswap";

/**
 * Labels an error with the venue it came from.
 *
 * Error numbers belong to a particular program: 6001 on the Jupiter aggregator
 * is slippage, on pump.fun it is AlreadyInitialized. Working the program out
 * from the message text is unreliable: messages are built in different places
 * and have already drifted from what the classifier expected ("DEX simulation
 * failed" against "DEX transaction"). The label is attached where the venue is
 * known for certain.
 */
export function tagVenue<E>(error: E, venue: ErrorVenue): E {
    if (error && typeof error === "object") {
        (error as { venue?: ErrorVenue }).venue = venue;
    }
    return error;
}

/** The error's venue, if it was labelled when thrown. */
export function getErrorVenue(error: unknown): ErrorVenue | null {
    if (!error || typeof error !== "object") {
        return null;
    }
    const venue = (error as { venue?: unknown }).venue;
    return venue === "pumpfun" || venue === "dex" || venue === "pumpswap"
        ? venue
        : null;
}

/**
 * How long a signed transaction stays valid.
 *
 * Needed for confirmation: we have to wait on the blockhash the transaction was
 * signed with. Take a fresh one after sending and its `lastValidBlockHeight`
 * lands about 150 slots later than the real one, so an expired transaction
 * would sit in the wait longer than makes sense — and our retry window is
 * time-limited.
 */
export interface SignedTxContext {
    blockhash: string;
    lastValidBlockHeight: number;
}

/** A purchase attempt, the moment before it goes out. */
export interface SentAttempt {
    signature: string;
    lastValidBlockHeight: number;
}

/**
 * What a buy path tells its caller on the way. `onSigned` runs after the
 * simulation passed and BEFORE the first send, so the attempt is written down
 * before it can land: a process that dies while waiting for the confirmation
 * leaves the signature behind, and the purchase is counted and not bought again.
 * If it throws, nothing has been sent.
 */
export interface BuyHooks {
    onSigned?: (attempt: SentAttempt) => void;
}

/**
 * Prepares and signs a transaction.
 * Adds the blockhash and feePayer, then signs.
 */
export async function signTransaction(
    tx: Transaction,
    signer: Keypair
): Promise<Transaction & { context: SignedTxContext }> {
    // We take our place in the send queue before signing: a blockhash lives
    // about a minute, and waiting your turn already signed risks a stale signature.
    await sendTxLimiter.acquire();
    const { blockhash, lastValidBlockHeight } =
        await connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.feePayer = signer.publicKey;
    tx.sign(signer);
    return Object.assign(tx, { context: { blockhash, lastValidBlockHeight } });
}

/**
 * Sends an already signed transaction and waits for confirmation
 */
export async function sendSignedTransaction(
    tx: Transaction & { context?: SignedTxContext }
): Promise<string> {
    const signature = await connection.sendRawTransaction(tx.serialize(), {
        skipPreflight: false,
        preflightCommitment: "confirmed",
    });

    // From here the transaction IS in the network, and any error must carry the
    // signature: without it the caller cannot tell "never arrived" from
    // "arrived, but we did not wait for the confirmation", and will send again.
    // The buying path has done this for a while; delivery used to throw a bare
    // Error and lose the signature, which sent a delivery that had arrived to
    // the recipient a second time.
    try {
        // We wait on the lifetime of that very signature. The fallback is for
        // transactions not signed by our helper: there is no context there, and
        // waiting on a fresh blockhash beats not waiting at all.
        const context =
            tx.context ?? (await connection.getLatestBlockhash());

        const confirmation = await connection.confirmTransaction({
            signature,
            blockhash: context.blockhash,
            lastValidBlockHeight: context.lastValidBlockHeight,
        });

        if (confirmation.value.err) {
            throw new Error(
                `Transaction confirmed but failed on-chain: ${JSON.stringify(confirmation.value.err)}`
            );
        }

        return signature;
    } catch (error) {
        if (error instanceof PostSendError) {
            throw error;
        }
        const message = error instanceof Error ? error.message : String(error);
        throw new PostSendError(
            `Transaction send/confirm failed: ${message}`,
            signature,
            error,
            tx.context?.lastValidBlockHeight
        );
    }
}

/** What `sendTransaction` reports between signing and sending. */
export interface SignedNotice {
    signature: string;
    lastValidBlockHeight: number;
}

/**
 * Signs and sends a transaction (the combo)
 * TODO: add a Jito bundle for production
 *
 * `onSigned` is called after signing and before anything goes out. A caller
 * that writes the signature down there can always find out later whether the
 * transaction landed, even if the process dies while it is being confirmed.
 */
export async function sendTransaction(
    tx: Transaction,
    signer: Keypair,
    onSigned?: (notice: SignedNotice) => void
): Promise<string> {
    const signed = await signTransaction(tx, signer);
    const signature = getSignedTransactionSignature(signed);
    if (onSigned && signature) {
        onSigned({ signature, lastValidBlockHeight: signed.context.lastValidBlockHeight });
    }
    return sendSignedTransaction(signed);
}
