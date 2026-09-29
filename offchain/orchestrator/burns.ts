// orchestrator/burns.ts
// Burning the share of a coin's tokens its backers asked to have destroyed.

/**
 * When. At the start of every delivery round, before that round's deliveries,
 * and once more in the settlement after the buying ends. The round is where
 * the shares are already worked out; doing the burn there keeps one place that
 * decides both what is sent and what is destroyed, from the same numbers at the
 * same moment, and it costs about a dozen transactions per coin rather than one
 * per purchase.
 *
 * How much. `burnOwed(B) − burned`, where B is what the purchases brought as
 * read from their own transactions (see `purchaseTokens`), never the keeper's
 * balance. The balance is only a ceiling: burning more than the account holds
 * would fail on chain anyway.
 *
 * Twice is the thing that must never happen. A delivery repeated overpays one
 * person; a burn repeated destroys tokens that belong to somebody else and
 * cannot be undone. So every burn is signed first, its signature written to the
 * round's state, and only then sent. Whatever happens next — a timeout, a node
 * that drops the answer, the process dying mid-send — the signature is on disk,
 * and before anything is burned again it is looked up on chain with the full
 * history. Landed: counted. Not on chain: may be sent again. Cannot tell: this
 * round burns nothing for the coin, and the next one asks again.
 *
 * What can refuse a burn, from the token programs' own `process_burn`:
 *   0x11 AccountFrozen             our account frozen by the mint's authority
 *   0x43 MintPaused                a Pausable mint that is paused
 *   0x41 IllegalMintBurnConversion ConfidentialMintBurn
 *   0x0c InvalidInstruction        PermissionedBurn wants a second signer
 * The last two are structural and the commit is refused for such coins; if one
 * turns up anyway the coin is marked blocked at once. The first two can be
 * lifted, so they are retried every round and marked blocked only by the
 * settlement. A blocked coin's burn share stays on the keeper and is reported.
 * It is never delivered: those tokens were promised to the fire, not to anyone.
 */

import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { createBurnCheckedInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";

import { Logger, logger as rootLogger } from "../logger";
import { connection } from "../solana/connection";
import { budgetInstructions } from "../solana/priorityFee";
import {
    getSignedTransactionSignature,
    PostSendError,
    sendSignedTransaction,
    signTransaction,
} from "../solana/transaction";
import { detectTokenProgram, getMintDecimals } from "./batchTransfer";
import { BatchLoader, tokensBought } from "./purchaseTokens";
import { burnOwed, sharesOf } from "./shares";
import { OrchestratorStateManager } from "./state";
import { BurnRecord } from "./types";
import { signatureOutcome, SignatureOutcome } from "../solana/signatureOutcome";

export type { SignatureOutcome };

/**
 * Compute for one burn transaction. Measured on 2026-09-28 by simulating a
 * BurnChecked against the keeper's real Token-2022 account: 1,950 units for the
 * burn, 2,100 for the transaction. A Token-2022 mint carrying more extensions
 * costs more to unpack, hence the headroom; the priority is paid on the limit,
 * and at these prices ten thousand units is tens of lamports.
 */
export const BURN_COMPUTE_UNITS = 10_000;

/** Errors a burn can meet that no retry will fix. */
const STRUCTURAL = [
    { code: "0x41", reason: "the coin's mint does not allow burning (ConfidentialMintBurn)" },
    { code: "0xc", reason: "the coin's mint only allows permissioned burns (PermissionedBurn)" },
];
/** Errors that can be lifted by the mint's authority; retried until the settlement. */
const LIFTABLE = [
    { code: "0x11", reason: "our token account for the coin is frozen" },
    { code: "0x43", reason: "the coin's mint is paused" },
];

export interface BurnDeps {
    logger?: Logger;
    loadBatch: BatchLoader;
    /** Overridable for tests. */
    signatureOutcome?: (signature: string, lastValidBlockHeight?: number) => Promise<SignatureOutcome>;
    tokenBalance?: (mint: PublicKey, owner: PublicKey, program: PublicKey) => Promise<bigint | null>;
    tokenProgram?: (mint: PublicKey) => Promise<PublicKey>;
    decimals?: (mint: PublicKey, program: PublicKey) => Promise<number>;
    /** Signs and returns the signature and a sender, so the signature is stored before sending. */
    signBurn?: (tx: Transaction, keeper: Keypair) => Promise<SignedBurn>;
    budget?: (accounts: PublicKey[]) => Promise<import("@solana/web3.js").TransactionInstruction[]>;
}

export type BurnResult = "burned" | "nothing" | "waiting" | "blocked" | "failed";

export interface SignedBurn {
    signature: string;
    /** The last block height the transaction can land at; see `signatureOutcome`. */
    lastValidBlockHeight?: number;
    send: () => Promise<string>;
}

async function defaultTokenBalance(mint: PublicKey, owner: PublicKey, program: PublicKey): Promise<bigint | null> {
    const account = getAssociatedTokenAddressSync(mint, owner, false, program);
    try {
        const balance = await connection.getTokenAccountBalance(account);
        return BigInt(balance.value.amount);
    } catch {
        return null;
    }
}

async function defaultSignBurn(tx: Transaction, keeper: Keypair): Promise<SignedBurn> {
    const signed = await signTransaction(tx, keeper);
    const signature = getSignedTransactionSignature(signed);
    if (!signature) {
        throw new Error("A signed burn has no signature");
    }
    return {
        signature,
        lastValidBlockHeight: signed.context.lastValidBlockHeight,
        send: () => sendSignedTransaction(signed),
    };
}

/**
 * Settles the fate of a burn that went out without a confirmation.
 * Returns false when the coin must not be burned this round.
 */
async function settlePending(
    stateManager: OrchestratorStateManager,
    mint: string,
    outcome: (signature: string, lastValidBlockHeight?: number) => Promise<SignatureOutcome>,
    log: Logger
): Promise<boolean> {
    const open = stateManager.getBurns().filter((burn) => burn.mint === mint && burn.status === "in_progress");
    for (const burn of open) {
        if (!burn.pendingSignature) {
            // Marked in progress but never signed: nothing can have gone out.
            stateManager.updateBurn(burn.id, { status: "failed", errorMessage: "never signed" });
            continue;
        }
        // Kept aside: `updateBurn` changes the record in place, and after it
        // the field is gone.
        const signature = burn.pendingSignature;
        const verdict = await outcome(signature, burn.pendingLastValidBlockHeight);
        if (verdict === "landed") {
            stateManager.updateBurn(burn.id, {
                status: "completed",
                signature,
                pendingSignature: undefined,
                pendingLastValidBlockHeight: undefined,
            });
            stateManager.addBurned(mint, BigInt(burn.rawAmount));
            log.info({ event: "burn.pending_landed", mint: mint.slice(0, 8), signature: signature.slice(0, 16) },
                "A burn that went out without a confirmation had landed");
            continue;
        }
        if (verdict === "absent" || verdict === "failed") {
            stateManager.updateBurn(burn.id, {
                status: "failed",
                errorMessage: verdict === "failed" ? "failed on chain" : "never landed",
            });
            continue;
        }
        log.warn({ event: "burn.pending_unknown", mint: mint.slice(0, 8), signature: signature.slice(0, 16) },
            "Cannot tell whether a burn landed; not burning this coin this round");
        return false;
    }
    return true;
}

/**
 * The reason for a program error in the message, if it is one of these.
 * Matched as a whole code: "0x1" must not answer for "0x11", nor "0xc" for "0xc8".
 */
function matchError(message: string, table: Array<{ code: string; reason: string }>): string | null {
    const lower = message.toLowerCase();
    for (const entry of table) {
        if (new RegExp(`custom program error: ${entry.code}(?![0-9a-f])`).test(lower)) {
            return entry.reason;
        }
    }
    return null;
}

/**
 * Burns what a coin owes, if anything.
 *
 * `final` is the settlement's call: a coin that is still refusing for a reason
 * the mint's authority could lift is marked blocked then, rather than retried
 * for ever.
 */
export async function burnDueFor(
    stateManager: OrchestratorStateManager,
    keeper: Keypair,
    mintStr: string,
    deps: BurnDeps,
    final = false
): Promise<BurnResult> {
    const log = deps.logger ?? rootLogger;
    const token = stateManager.getTokenBuy(mintStr);
    if (!token) {
        return "nothing";
    }
    if (token.burnBlocked) {
        return "blocked";
    }
    const shares = sharesOf(stateManager.getState(), mintStr);
    const outcome = deps.signatureOutcome ?? signatureOutcome;

    if (!(await settlePending(stateManager, mintStr, outcome, log))) {
        return "waiting";
    }

    const bought = tokensBought(stateManager.getState(), mintStr, deps.loadBatch).known;
    const owed = burnOwed(bought, shares);
    const burned = BigInt(stateManager.getTokenBuy(mintStr)?.burnedRaw ?? "0");
    let due = owed - burned;
    if (due <= 0n) {
        return "nothing";
    }

    const mint = new PublicKey(mintStr);
    let program: PublicKey;
    let decimals: number;
    try {
        program = await (deps.tokenProgram ?? detectTokenProgram)(mint);
        decimals = await (deps.decimals ?? getMintDecimals)(mint, program);
    } catch (error) {
        log.warn({ event: "burn.mint_unreadable", mint: mintStr.slice(0, 8), error: String(error) },
            "Mint unreadable, burning next round");
        return "waiting";
    }

    // The balance is a ceiling, not a basis: it can be stale by our own last
    // transaction, and a burn can never be bigger than what the account holds.
    const balance = await (deps.tokenBalance ?? defaultTokenBalance)(mint, keeper.publicKey, program);
    if (balance !== null && balance < due) {
        log.warn({ event: "burn.short", mint: mintStr.slice(0, 8), due: due.toString(), balance: balance.toString() },
            "Less on the keeper than the burn owed; burning what is there");
        due = balance;
    }
    if (due <= 0n) {
        return "waiting";
    }

    const account = getAssociatedTokenAddressSync(mint, keeper.publicKey, false, program);
    const budget = deps.budget
        ? await deps.budget([account, mint])
        : await budgetInstructions("delivery", BURN_COMPUTE_UNITS, [account, mint]);
    const tx = new Transaction().add(
        ...budget,
        createBurnCheckedInstruction(account, mint, keeper.publicKey, due, decimals, [], program)
    );

    const now = Date.now();
    const record: BurnRecord = {
        id: `burn_${mintStr.slice(0, 8)}_${now}_${stateManager.getBurns().length + 1}`,
        mint: mintStr,
        rawAmount: due.toString(),
        status: "in_progress",
        attempts: 1,
        createdAt: now,
        updatedAt: now,
    };

    let signed: SignedBurn;
    try {
        signed = await (deps.signBurn ?? defaultSignBurn)(tx, keeper);
    } catch (error) {
        log.warn({ event: "burn.sign_failed", mint: mintStr.slice(0, 8), error: String(error) }, "Could not sign a burn");
        return "waiting";
    }
    // Written before sending: from here on there is always a signature to check.
    record.pendingSignature = signed.signature;
    record.pendingLastValidBlockHeight = signed.lastValidBlockHeight;
    stateManager.addBurn(record);

    try {
        const signature = await signed.send();
        stateManager.updateBurn(record.id, {
            status: "completed",
            signature,
            pendingSignature: undefined,
            pendingLastValidBlockHeight: undefined,
        });
        stateManager.addBurned(mintStr, due);
        log.info({ event: "burn.completed", mint: mintStr.slice(0, 8), raw: due.toString(), signature: signature.slice(0, 16) },
            `Burned ${due} raw of ${mintStr.slice(0, 8)}`);
        return "burned";
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const structural = matchError(message, STRUCTURAL);
        const liftable = matchError(message, LIFTABLE);

        if (structural || liftable) {
            // Refused by the program: the transaction failed, nothing was burned.
            stateManager.updateBurn(record.id, {
                status: "failed",
                pendingSignature: undefined,
                pendingLastValidBlockHeight: undefined,
                errorMessage: message,
            });
            if (structural || final) {
                stateManager.updateTokenBuy(mintStr, { burnBlocked: { reason: structural ?? liftable!, at: Date.now() } });
                log.error({ event: "burn.blocked", mint: mintStr.slice(0, 8), reason: structural ?? liftable },
                    `Burning ${mintStr.slice(0, 8)} is blocked: ${structural ?? liftable}`);
                return "blocked";
            }
            log.warn({ event: "burn.refused", mint: mintStr.slice(0, 8), reason: liftable }, `Burn refused: ${liftable}`);
            return "failed";
        }

        // Anything else keeps the signature: it may have landed. The next call
        // looks it up before doing anything.
        const signature = error instanceof PostSendError ? error.signature ?? signed.signature : signed.signature;
        stateManager.updateBurn(record.id, { pendingSignature: signature, errorMessage: message });
        log.warn({ event: "burn.unconfirmed", mint: mintStr.slice(0, 8), signature: signature.slice(0, 16), error: message },
            "Burn sent without a confirmation; checked before anything else is burned");
        return "waiting";
    }
}
