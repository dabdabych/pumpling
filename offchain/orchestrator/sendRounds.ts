// orchestrator/sendRounds.ts
// Send rounds — interleaved with buy loop

import { Keypair, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { connection } from "../solana/connection";
import { PostSendError } from "../solana/transaction";
import { signatureOutcome } from "../solana/signatureOutcome";
import { sendTransaction } from "../solana/transaction";
import { classifyError } from "../scheduler/errors";
import { logger as rootLogger, Logger } from "../logger";
import { Semaphore } from "./semaphore";
import { buildBatchSendTransaction, detectTokenProgram } from "./batchTransfer";
import { deliveryOwed, hasBurn, Share, sharesOf } from "./shares";
import { burnDueFor } from "./burns";
import { readBatchFile } from "./batchFile";
import { refreshPurchaseTokens, tokensBought } from "./purchaseTokens";
import { OrchestratorStateManager } from "./state";
import { LotteryState, SendRecord } from "./types";

// =============================================================================
// CALCULATE SEND N
// =============================================================================

/**
 * Works out how many delivery rounds a commit gets.
 *
 * < 1   → 1
 * 1-20  → linear 1→10 (3 at 5 SOL)
 * ≥ 20  → 10
 *
 * The formula for [1, 20]: floor(3 + (sol - 5) × 7/15)
 */
export function calculateSendN(solBet: number): number {
    if (solBet <= 0) return 0;
    if (solBet < 1) return 1;
    if (solBet >= 20) return 10;

    return Math.max(1, Math.floor(3 + ((solBet - 5) * 7) / 15));
}

// =============================================================================
// GENERATE SEND RECORDS
// =============================================================================

/**
 * Works out the rounds for a recipient with sendN deliveries.
 * They are spread evenly across the window, the last one in the final round.
 *
 * sendN=1, totalRounds=10 → [10]
 * sendN=4, totalRounds=10 → [3, 5, 8, 10]
 * sendN=10, totalRounds=10 → [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
 */
export function assignRounds(sendN: number, totalRounds: number): number[] {
    if (sendN <= 0 || totalRounds <= 0) return [];
    if (sendN >= totalRounds) {
        return Array.from({ length: totalRounds }, (_, i) => i + 1);
    }

    const rounds: number[] = [];
    // An even step, anchored to the last round
    const step = totalRounds / sendN;
    for (let i = 1; i <= sendN; i++) {
        rounds.push(Math.ceil(i * step));
    }
    return rounds;
}

/**
 * Generates a SendRecord for every recipient × round.
 * Rounds are spread evenly across the window instead of bunching at the start.
 */
export function generateSendRecords(
    tokens: Array<{
        mint: PublicKey;
        recipients: Array<{
            publickey: PublicKey;
            amount: number;
        }>;
    }>,
    totalRounds: number = 10,
    ataSnapshot?: Map<string, boolean>
): SendRecord[] {
    const records: SendRecord[] = [];
    let idCounter = 1;

    for (const token of tokens) {
        const totalBets = token.recipients.reduce((s, r) => s + r.amount, 0);
        if (totalBets <= 0) continue;

        for (const r of token.recipients) {
            const share = r.amount / totalBets;
            const sendN = calculateSendN(r.amount);
            const rounds = assignRounds(sendN, totalRounds);

            for (let i = 0; i < rounds.length; i++) {
                const snapshotKey = `${token.mint.toBase58()}:${r.publickey.toBase58()}`;
                const hadAtaAtStart = ataSnapshot?.get(snapshotKey);
                records.push({
                    id: `send_${idCounter++}`,
                    mint: token.mint.toBase58(),
                    recipient: r.publickey.toBase58(),
                    recipientBetSol: r.amount,
                    share,
                    sendN: rounds.length,
                    round: rounds[i],
                    status: "pending",
                    attempts: 0,
                    hadAtaAtStart,
                    updatedAt: Date.now(),
                });
            }
        }
    }

    return records;
}

// =============================================================================
// GET TOKEN BALANCE
// =============================================================================

/**
 * Reads the keeper's balance of a token.
 */
export async function getTokenBalance(
    mint: PublicKey,
    owner: PublicKey
): Promise<bigint> {
    try {
        const tokenProgramId = await detectTokenProgram(mint);
        const ata = getAssociatedTokenAddressSync(
            mint,
            owner,
            false,
            tokenProgramId
        );
        const info = await connection.getTokenAccountBalance(ata);
        return BigInt(info.value.amount);
    } catch {
        return 0n;
    }
}

// =============================================================================
// ATA SNAPSHOT
// =============================================================================

/**
 * Takes a snapshot of which recipients have an ATA.
 * Used as a fraud guard: < 0.5 SOL + the ATA disappeared → ata_mismatch,
 * ≥ 1 SOL + the ATA disappeared → defer to the last round.
 * Key: "mint:recipient" -> true/false
 */
export async function snapshotRecipientAtas(
    tokens: Array<{
        mint: PublicKey;
        recipients: Array<{
            publickey: PublicKey;
            amount: number;
        }>;
    }>,
    concurrency: number
): Promise<Map<string, boolean>> {
    const result = new Map<string, boolean>();
    const sem = new Semaphore(Math.max(1, concurrency));

    const tasks: Promise<void>[] = [];
    for (const token of tokens) {
        for (const r of token.recipients) {
            const mint = token.mint;
            const recipient = r.publickey;
            const key = `${mint.toBase58()}:${recipient.toBase58()}`;
            tasks.push(
                sem.use(async () => {
                    try {
                        const tokenProgramId = await detectTokenProgram(mint);
                        const ata = getAssociatedTokenAddressSync(
                            mint,
                            recipient,
                            false,
                            tokenProgramId
                        );
                        const info = await connection.getAccountInfo(ata);
                        result.set(key, info !== null);
                    } catch {
                        result.set(key, false);
                    }
                })
            );
        }
    }

    await Promise.all(tasks);
    return result;
}

// =============================================================================
// CALCULATE SEND AMOUNTS (DEFICIT-BASED)
// =============================================================================

/**
 * Works out the amount for each delivery in a round, using the deficit approach.
 *
 * For every recipient:
 *
 * where totalTokens = balance + sum(completed send amounts for that mint).
 * This keeps the proportions exact whatever sendN and the buying timing do.
 *
 * If sum(deficits) > balance, scale down proportionally.
 */
/**
 * The exact basis for a coin some of whose backers burn.
 *
 * Without it the pot is inferred from the balance, which after a burn no longer
 * says anything about proportions: the burned share would silently go to the
 * people who did not burn (simulated: 363 broken promises in 400 rounds). With
 * it, a wallet's target is its own share of everything bought, less its own
 * burn — see `shares.ts`.
 */
export interface DeliveryBasis {
    /** Every token bought for the coin, from the purchases' own transactions. */
    bought: bigint;
    shares: Share[];
}

export function calculateDeficitAmounts(
    activeSends: SendRecord[],
    allMintSends: SendRecord[],
    balance: bigint,
    basis?: DeliveryBasis
): Map<string, bigint> {
    const result = new Map<string, bigint>();
    if (activeSends.length === 0 || balance <= 0n) return result;

    // Total tokens = balance on hand + already sent
    let alreadySentTotal = 0n;
    for (const s of allMintSends) {
        if (s.status === "completed" && s.amount) {
            alreadySentTotal += BigInt(s.amount);
        }
    }
    const totalTokens = balance + alreadySentTotal;
    const exactTarget = (recipient: string): bigint | null =>
        basis ? deliveryOwed(basis.bought, recipient, basis.shares) : null;

    // Already sent per recipient. Against the exact basis that is what left
    // the keeper (see `SendRecord.grossAmount`); the inferred basis has always
    // counted what arrived, and keeps doing so.
    const recipientSent = new Map<string, bigint>();
    for (const s of allMintSends) {
        if (s.status === "completed" && s.amount) {
            const counted = basis ? sentFromKeeper(s) : BigInt(s.amount);
            recipientSent.set(s.recipient, (recipientSent.get(s.recipient) || 0n) + counted);
        }
    }

    // Bet totals per recipient (lamports) and total bet (lamports)
    const recipientBetLamports = new Map<string, bigint>();
    let totalBetLamports = 0n;
    for (const s of allMintSends) {
        if (recipientBetLamports.has(s.recipient)) continue;
        const betLamports = BigInt(Math.round(s.recipientBetSol * 1e9));
        recipientBetLamports.set(s.recipient, betLamports);
        totalBetLamports += betLamports;
    }
    if (totalBetLamports <= 0n) return result;

    // Deficit per recipient (deduplicate — multiple active sends for same recipient)
    const recipientDeficit = new Map<string, bigint>();
    const recipientActiveSends = new Map<string, SendRecord[]>();

    for (const s of activeSends) {
        if (!recipientActiveSends.has(s.recipient)) {
            const betLamports = recipientBetLamports.get(s.recipient) || 0n;
            const target = exactTarget(s.recipient) ?? (totalTokens * betLamports) / totalBetLamports;
            const sent = recipientSent.get(s.recipient) || 0n;
            recipientDeficit.set(s.recipient, target > sent ? target - sent : 0n);
            recipientActiveSends.set(s.recipient, []);
        }
        recipientActiveSends.get(s.recipient)!.push(s);
    }

    // Total deficit across all active recipients
    let totalDeficit = 0n;
    for (const d of recipientDeficit.values()) {
        totalDeficit += d;
    }
    if (totalDeficit <= 0n) return result;

    // Distribute: if totalDeficit ≤ balance, give exact deficit
    // Otherwise scale down proportionally
    const entries = [...recipientDeficit.entries()];
    let distributed = 0n;

    for (let i = 0; i < entries.length; i++) {
        const [recipient, deficit] = entries[i];
        const sends = recipientActiveSends.get(recipient)!;

        let recipientAmount: bigint;
        if (i === entries.length - 1) {
            recipientAmount = (totalDeficit <= balance ? totalDeficit : balance) - distributed;
        } else if (totalDeficit <= balance) {
            recipientAmount = deficit;
        } else {
            recipientAmount = (balance * deficit) / totalDeficit;
        }
        distributed += recipientAmount;

        if (recipientAmount <= 0n) continue;

        // Split evenly among this recipient's active sends
        const perSend = recipientAmount / BigInt(sends.length);
        let sendDistributed = 0n;
        for (let j = 0; j < sends.length; j++) {
            const amount = j === sends.length - 1
                ? recipientAmount - sendDistributed
                : perSend;
            if (amount > 0n) {
                result.set(sends[j].id, amount);
            }
            sendDistributed += amount;
        }
    }

    return result;
}

/** What a completed delivery took from the keeper. */
export function sentFromKeeper(send: SendRecord): bigint {
    const raw = send.grossAmount ?? send.amount;
    return raw && /^\d+$/.test(raw) ? BigInt(raw) : 0n;
}

/**
 * The coins some of whose backers asked for a burn.
 *
 * Their deliveries are always worked out from the exact basis, even once the
 * burn itself is blocked: the old formula would hand the unburned share to the
 * people who did not burn, and those tokens were promised to the fire, not to
 * them. They stay on the keeper instead.
 */
export function mintsWithBurners(state: LotteryState): string[] {
    return (state.tokenBuys ?? [])
        .filter((token) => hasBurn(sharesOf(state, token.mint)))
        .map((token) => token.mint);
}

// =============================================================================
// SLEEP HELPER
// =============================================================================

export const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms));

// Match only compute-specific errors. Broad patterns like "exceeded" or "compute"
// would false-positive on "Transaction size exceeded", "Slot exceeded", etc.,
// triggering useless batch splits that don't help.
/**
 * The batch does not fit, either on compute or on transaction size.
 *
 * Both are cured the same way, by halving, which is written below. Size ended
 * up here because of hooks: they add accounts to every transfer, and five
 * recipients stop fitting into 1232 bytes. `tx.serialize()` throws that
 * locally, before the network, and previously the message matched no pattern
 * at all so the purchase went through three useless retries.
 */
function isBatchTooLargeError(error: unknown): boolean {
    const msg = error instanceof Error ? error.message : String(error);
    return (
        msg.includes("ComputeBudget") ||
        msg.includes("compute units exceeded") ||
        msg.includes("Compute units exceeded") ||
        msg.includes("exceeded CUs") ||
        msg.includes("Transaction too large") ||
        msg.includes("encoding overruns")
    );
}

// =============================================================================
// EXECUTE SEND ROUNDS
// =============================================================================

export interface ExecuteSendRoundsParams {
    keeper: Keypair;
    stateManager: OrchestratorStateManager;
    totalRounds: number;
    intervalMs: number;
    sendConcurrency: number;
    startTime: number;
    sleepFn?: (ms: number) => Promise<void>;
    /** Sweep mode: ignores the round filter and takes every pending send */
    isSweep?: boolean;
    /** Structured logger (pino). */
    logger?: Logger;
}

/**
 * Runs all the delivery rounds.
 *
 * For each round:
 * 1. Waits until its moment
 * 2. Collects pending/failed sends from this round and earlier ones
 *    (earlier ones may have been skipped because balance=0, buying unfinished)
 * 3. Per mint: checks the balance, works out the amounts
 * 4. Groups by 5 recipients → buildBatchSendTx → send
 * 5. After every round: failed → abandoned
 */
/**
 * The attempt limit for one delivery.
 *
 * Exported because the sweep in the orchestrator revives deliveries from
 * `abandoned` and has to respect the same limit — otherwise it would get around
 * it by requeueing something that has already used up its attempts.
 */
export const MAX_SEND_ATTEMPTS = 3;

/**
 * Closes a delivery if its previous transaction did arrive after all.
 *
 * The mirror of `checkPendingSignature` from the buying side. A late
 * confirmation (`block height exceeded`) is classified as retryable and the
 * delivery goes back into the queue — but the transaction may have executed all
 * the same. Without this check a recipient got their share twice while the
 * others came up short out of the same remainder: `calculateDeficitAmounts`
 * only counts `completed`, so a delivery that arrived without confirming was
 * invisible even though the tokens had already left the keeper.
 *
 * @returns true if the delivery was closed as done
 */
async function checkPendingSend(
    send: SendRecord,
    stateManager: OrchestratorStateManager,
    log: Logger
): Promise<"send" | "settled" | "unknown"> {
    if (!send.pendingSignature) {
        return "send";
    }

    // Landed: closed below. Absent or failed on chain: nothing arrived, send.
    // Anything else — the status could not be read, the transaction is only
    // processed, or it is not found while its blockhash can still carry it —
    // means we do not know. Skipping a delivery is recoverable: the signature
    // stays and the next pass asks again. Sending blind is not: an overpayment
    // cannot be recalled, and the others come up short out of the same
    // remainder.
    const outcome = await signatureOutcome(send.pendingSignature, send.pendingLastValidBlockHeight);
    if (outcome === "unknown") {
        log.warn({
            event: "send.pending_check_failed",
            sendId: send.id,
            signature: send.pendingSignature.slice(0, 16),
        }, "Cannot tell whether the send landed, skipping this round");
        stateManager.incrementMetric("send.pendingCheckFailed");
        return "unknown";
    }
    if (outcome === "failed") {
        // It ran and failed: nothing arrived, the fee was paid. The signature
        // moves to the record's history so the accounting still sees it.
        stateManager.updateSend(send.id, {
            failedSignatures: [...(send.failedSignatures ?? []), send.pendingSignature],
            pendingSignature: undefined,
            pendingLastValidBlockHeight: undefined,
        });
        return "send";
    }
    if (outcome === "absent") {
        // Never landed and never will: it cost nothing and there is nothing to track.
        stateManager.updateSend(send.id, { pendingSignature: undefined, pendingLastValidBlockHeight: undefined });
        return "send";
    }

    // Remember it before the update: updateSend changes the record in place and
    // afterwards the field is empty.
    const signature = send.pendingSignature;
    stateManager.updateSend(send.id, {
        status: "completed",
        signature,
        pendingSignature: undefined,
        pendingLastValidBlockHeight: undefined,
        // `amount` is still what was put into that transaction, so it is the
        // gross figure; on a transfer-fee mint the recipient got less.
        grossAmount: send.amount,
    });
    stateManager.incrementMetric("send.pendingTxConfirmed");
    log.info({
        event: "send.pending_confirmed",
        sendId: send.id,
        signature: signature.slice(0, 16),
    }, "Send already landed, not resending");
    return "settled";
}

export async function executeSendRounds(
    params: ExecuteSendRoundsParams
): Promise<void> {
    const {
        keeper,
        stateManager,
        totalRounds,
        intervalMs,
        sendConcurrency,
        startTime,
        sleepFn = sleep,
        isSweep = false,
        logger: parentLog,
    } = params;

    const log = parentLog || rootLogger;
    const sem = new Semaphore(sendConcurrency);

    for (let round = 1; round <= totalRounds; round++) {
        // Wait until the right time
        const targetTime = startTime + round * intervalMs;
        const waitMs = targetTime - Date.now();
        if (waitMs > 0) {
            await sleepFn(waitMs);
        }

        log.info({
            event: isSweep ? "send.sweep_round" : "send.round_start",
            round,
            totalRounds,
        }, isSweep ? "Sweep send round" : `Send round ${round}/${totalRounds}`);

        // Gather pending sends for this round + carry-forward from previous rounds
        // (previous rounds may have been skipped due to 0 balance — buy not finished yet)
        // Failed sends are NOT retried here — they stay failed → abandoned at the end
        const state = stateManager.getState();
        const pendingSends = state.sends.filter(
            (s) => s.status === "pending" && (isSweep || s.round <= round)
        );

        // Coins some of whose backers burn. They are visited every round,
        // deliveries or not: a coin where everybody asked for 100% has no
        // deliveries at all, and a loop over deliveries alone would never burn
        // it. Their purchases are read first, since the burn and the deliveries
        // are both worked out from what those purchases really brought.
        const exact = mintsWithBurners(state);
        if (exact.length > 0) {
            await refreshPurchaseTokens(stateManager, keeper.publicKey, exact, readBatchFile, { logger: log });
        }

        if (pendingSends.length === 0 && exact.length === 0) {
            log.debug({ event: "send.round_empty", round }, "No pending sends this round");
            continue;
        }

        // Group by mint
        const byMint = new Map<string, SendRecord[]>();
        for (const s of pendingSends) {
            const arr = byMint.get(s.mint) || [];
            arr.push(s);
            byMint.set(s.mint, arr);
        }

        const sendPromises: Promise<void>[] = [];
        const visit = [...new Set([...exact, ...byMint.keys()])];

        for (const mintStr of visit) {
            const sends = byMint.get(mintStr) ?? [];
            const burns = exact.includes(mintStr);
            // The burn goes first and is awaited: the deliveries below are
            // worked out from the same total, and must not race it for the
            // tokens. A blocked coin skips the burn and keeps the exact basis.
            if (burns && !stateManager.getTokenBuy(mintStr)?.burnBlocked) {
                await burnDueFor(stateManager, keeper, mintStr, { logger: log, loadBatch: readBatchFile });
            }
            if (sends.length === 0) {
                continue;
            }
            const mint = new PublicKey(mintStr);

            // The coin may not be on the network at all: the mint is closed,
            // the address is wrong, the node will not return the account. This
            // exception used to travel up and take down the whole round, along
            // with the refund of unspent SOL that runs in the next phase. One
            // coin's trouble stays one coin's trouble: its deliveries wait for
            // the next pass.
            let tokenProgramId: PublicKey;
            try {
                tokenProgramId = await detectTokenProgram(mint);
            } catch (error) {
                log.error({
                    event: "send.mint_unreadable",
                    mint: mintStr.slice(0, 8),
                    error: error instanceof Error ? error.message : String(error),
                }, `Mint unreadable, skipping its sends this round: ${mintStr.slice(0, 8)}`);
                continue;
            }

            // We settle the fate of stuck signatures BEFORE working out the
            // amounts. A delivery that arrived has to land in `alreadySent`,
            // otherwise `totalTokens` comes out too low and the other
            // recipients come up short: their targets are computed from the
            // common pot, which no longer counts it.
            const skipUnknown = new Set<string>();
            for (const s of sends) {
                const verdict = await checkPendingSend(s, stateManager, log);
                if (verdict === "unknown") {
                    skipUnknown.add(s.id);
                }
            }
            // A wallet with a transfer whose fate is unknown gets nothing this
            // round, from any of its records. The deficit counts only what is
            // confirmed, so while that transfer may have landed, its tokens
            // look undelivered, and another record would send them again —
            // out of the others' share.
            const unsure = new Set(sends.filter((s) => skipUnknown.has(s.id)).map((s) => s.recipient));

            // ATA rules per recipient
            const byRecipient = new Map<string, SendRecord[]>();
            for (const s of sends) {
                const arr = byRecipient.get(s.recipient) || [];
                arr.push(s);
                byRecipient.set(s.recipient, arr);
            }

            const allowedSendIds = new Set<string>();

            for (const [recipient, recSends] of byRecipient) {
                if (unsure.has(recipient)) {
                    continue;
                }
                const sample = recSends[0];
                const hadAtaAtStart = sample.hadAtaAtStart === true;

                // Only check ATA if we expected it to exist initially
                let hasAtaNow = true;
                if (hadAtaAtStart) {
                    const ata = getAssociatedTokenAddressSync(
                        mint,
                        new PublicKey(recipient),
                        false,
                        tokenProgramId
                    );
                    const info = await connection.getAccountInfo(ata);
                    hasAtaNow = info !== null;
                }

                if (sample.recipientBetSol < 1) {
                    // <1 SOL: if ATA was expected but missing, apply threshold
                    if (hadAtaAtStart && !hasAtaNow && sample.recipientBetSol < 0.5) {
                        for (const s of recSends) {
                            stateManager.updateSend(s.id, {
                                status: "ata_mismatch",
                                ataMismatch: true,
                                errorMessage: "ATA_MISMATCH",
                            });
                        }
                        stateManager.incrementMetric("send.ataMismatchBlocked", recSends.length);
                        log.warn({
                            event: "send.ata_mismatch_blocked",
                            mint: mintStr.slice(0, 8),
                            recipient: recipient.slice(0, 8),
                            betSol: sample.recipientBetSol,
                        }, "ATA mismatch blocked (< 0.5 SOL)");
                        continue;
                    }
                    // Otherwise allow send (forgive for 0.5-1 or had no ATA)
                    if (hadAtaAtStart && !hasAtaNow) {
                        stateManager.incrementMetric("send.ataForgiven", recSends.length);
                    }
                    for (const s of recSends) {
                        allowedSendIds.add(s.id);
                    }
                    continue;
                }

                // >=1 SOL: defer if ATA was expected and is missing (except last round)
                if (hadAtaAtStart && !hasAtaNow && round < totalRounds) {
                    stateManager.incrementMetric("send.ataDeferred", recSends.length);
                    continue;
                }
                if (hadAtaAtStart && !hasAtaNow && round >= totalRounds) {
                    stateManager.incrementMetric("send.ataDeferredSent", recSends.length);
                }

                for (const s of recSends) {
                    allowedSendIds.add(s.id);
                }
            }

            // Get balance
            const balance = await getTokenBalance(mint, keeper.publicKey);
            if (balance <= 0n) {
                stateManager.incrementMetric("send.carryForward", sends.length);
                log.debug({ event: "send.carry_forward", mint: mintStr.slice(0, 8), round }, "Balance=0, carry forward");
                continue;
            }

            // Calculate amounts (deficit-based: considers already-sent tokens)
            const allMintSends = state.sends.filter((s) => s.mint === mintStr);
            const allowedSends = sends.filter(
                (s) => s.status === "pending" && allowedSendIds.has(s.id)
            );
            const basis = burns
                ? {
                    bought: tokensBought(stateManager.getState(), mintStr, readBatchFile).known,
                    shares: sharesOf(stateManager.getState(), mintStr),
                }
                : undefined;
            const amounts = calculateDeficitAmounts(allowedSends, allMintSends, balance, basis);

            // Mark allowed sends with deficit=0 as "satisfied" — recipient
            // already received their target via earlier completed sends, so
            // this slot is not needed. Without this, they'd stay "pending"
            // forever and lottery.complete would under-report delivery.
            for (const s of allowedSends) {
                if (!amounts.has(s.id)) {
                    stateManager.updateSend(s.id, { status: "satisfied" });
                    stateManager.incrementMetric("send.satisfied");
                }
            }

            // Group into batches of 5
            const sendEntries = allowedSends.filter((s) => amounts.has(s.id));
            for (let i = 0; i < sendEntries.length; i += 5) {
                const batch = sendEntries.slice(i, i + 5);

                sendPromises.push(
                    sem.use(async () => {
                        const sendBatch = async (entries: SendRecord[]): Promise<void> => {
                            // Part of the batch may have arrived on the last
                            // attempt. Those get closed and dropped from the
                            // batch, or the recipient would get their share a
                            // second time. We also drop the ones whose fate
                            // could not be established: sending blind is worse
                            // than skipping a pass, an overpayment cannot be
                            // recalled.
                            const fresh = entries.filter((s) => !skipUnknown.has(s.id));
                            if (fresh.length === 0) {
                                return;
                            }
                            entries = fresh;

                            const batchRecipients = entries.map((s) => ({
                                wallet: new PublicKey(s.recipient),
                                amount: amounts.get(s.id)!,
                            }));

                            // Mark in_progress
                            for (const s of entries) {
                                stateManager.updateSend(s.id, {
                                    status: "in_progress",
                                    amount: amounts.get(s.id)!.toString(),
                                });
                            }

                            try {
                                const { tx, deliveredAmounts } = await buildBatchSendTransaction(
                                    mint,
                                    batchRecipients,
                                    keeper
                                );
                                // The signature is written down before the
                                // transaction leaves: if the process dies while it
                                // is being confirmed, recovery finds it and asks
                                // the chain instead of sending again.
                                const signature = await sendTransaction(tx, keeper, (signed) => {
                                    for (const s of entries) {
                                        stateManager.updateSend(s.id, {
                                            pendingSignature: signed.signature,
                                            pendingLastValidBlockHeight: signed.lastValidBlockHeight,
                                        });
                                    }
                                });

                                for (const [i, s] of entries.entries()) {
                                    // We record what ARRIVED, not what was
                                    // sent. On a mint with a transfer fee those
                                    // are different numbers, and the deficit
                                    // calculation in later rounds depends on
                                    // the record: by the gross figure the
                                    // recipient would look better supplied than
                                    // they are.
                                    stateManager.updateSend(s.id, {
                                        status: "completed",
                                        signature,
                                        pendingSignature: undefined,
                                        pendingLastValidBlockHeight: undefined,
                                        amount: deliveredAmounts[i].toString(),
                                        grossAmount: amounts.get(s.id)!.toString(),
                                        attempts: s.attempts + 1,
                                    });
                                }

                                if (isSweep) {
                                    stateManager.incrementMetric("sweep.sendCompleted", entries.length);
                                }

                                log.info({
                                    event: "send.batch_completed",
                                    mint: mintStr.slice(0, 8),
                                    recipients: entries.length,
                                    signature: signature.slice(0, 16),
                                    round,
                                    sweep: isSweep,
                                }, `Sent ${entries.length} recipients for ${mintStr.slice(0, 8)}`);
                            } catch (error) {
                                if (isBatchTooLargeError(error) && entries.length > 1) {
                                    // Too big to serialize never left; too big to
                                    // run landed and failed, paying its fee. Either
                                    // way nothing arrived, so the halves may go now.
                                    const tried = error instanceof PostSendError ? error.signature : undefined;
                                    for (const s of entries) {
                                        stateManager.updateSend(s.id, {
                                            failedSignatures: tried
                                                ? [...(s.failedSignatures ?? []), tried]
                                                : s.failedSignatures,
                                            pendingSignature: undefined,
                                            pendingLastValidBlockHeight: undefined,
                                        });
                                    }
                                    stateManager.incrementMetric("send.computeLimitSplit");
                                    log.warn({
                                        event: "send.compute_limit_split",
                                        mint: mintStr.slice(0, 8),
                                        batchSize: entries.length,
                                    }, "Compute limit hit, splitting batch");
                                    const mid = Math.ceil(entries.length / 2);
                                    const left = entries.slice(0, mid);
                                    const right = entries.slice(mid);
                                    await sendBatch(left);
                                    await sendBatch(right);
                                    return;
                                }

                                const msg =
                                    error instanceof Error
                                        ? error.message
                                        : String(error);
                                const { errorClass } = classifyError(error);

                                for (const s of entries) {
                                    if (errorClass === "non-retryable") {
                                        stateManager.updateSend(s.id, {
                                            status: "abandoned",
                                            errorMessage: msg,
                                            attempts: s.attempts + 1,
                                        });
                                        stateManager.incrementMetric("send.nonRetryableAbandon");
                                        continue;
                                    }
                                }

                                // Retryable/unknown: reset to pending for next round,
                                // but cap at MAX_SEND_ATTEMPTS to avoid infinite retry loops
                                // (e.g. persistent 429 from overloaded RPC).
                                if (errorClass !== "non-retryable") {
                                    // Every round alike, the last one included:
                                    // remember the signature of a transaction
                                    // that may have flown, and leave the
                                    // delivery in the queue. The sweep after the
                                    // buying looks the signature up before it
                                    // sends anything.
                                    //
                                    // The last round used to retry on the spot
                                    // instead, rebuilding the transaction without
                                    // asking whether the first one had landed —
                                    // `block height exceeded` says only that the
                                    // wait ran out, not that nothing arrived.
                                    // That was a double delivery waiting to
                                    // happen, and the settlement that now runs
                                    // after the buying makes the shortcut
                                    // unnecessary.
                                    // Whatever the error, a transaction that was
                                    // signed may have gone out: a dropped
                                    // connection on the send call is not a
                                    // PostSendError, and it may still have landed.
                                    // So the signature recorded at signing stays
                                    // unless the error names one itself.
                                    const pendingSignature =
                                        error instanceof PostSendError && error.signature
                                            ? error.signature
                                            : entries[0]?.pendingSignature;
                                    const pendingLastValidBlockHeight =
                                        error instanceof PostSendError && error.signature
                                            ? error.lastValidBlockHeight
                                            : entries[0]?.pendingLastValidBlockHeight;
                                    for (const s of entries) {
                                        if (s.attempts + 1 >= MAX_SEND_ATTEMPTS) {
                                            stateManager.updateSend(s.id, {
                                                status: "abandoned",
                                                errorMessage: msg,
                                                attempts: s.attempts + 1,
                                                pendingSignature,
                                                pendingLastValidBlockHeight,
                                            });
                                            stateManager.incrementMetric("send.maxAttemptsAbandon");
                                        } else {
                                            stateManager.updateSend(s.id, {
                                                status: "pending",
                                                errorMessage: msg,
                                                attempts: s.attempts + 1,
                                                pendingSignature,
                                                pendingLastValidBlockHeight,
                                            });
                                            stateManager.incrementMetric("send.retryableToPending");
                                        }
                                    }
                                    if (isSweep) {
                                        stateManager.incrementMetric("sweep.sendFailed", entries.length);
                                    }
                                }

                                log.warn({
                                    event: "send.batch_failed",
                                    mint: mintStr.slice(0, 8),
                                    recipients: entries.length,
                                    errorClass,
                                    error: msg,
                                    round,
                                }, `Failed batch for ${mintStr.slice(0, 8)}: ${msg}`);
                            }
                        };

                        await sendBatch(batch);
                    })
                );
            }
        }

        await Promise.all(sendPromises);
    }

}
