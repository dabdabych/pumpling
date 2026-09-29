// orchestrator/settle.ts
// After the buying: burn what is still owed and top up everyone short.

/**
 * Why this exists.
 *
 * Round 1790348400190 (2026-09-25): purchase #28 expired, was bought again in
 * the second pass at 17:11:23, and the last delivery round had run at 17:10:10.
 * All six deliveries were already `completed`, and the sweep that follows the
 * buying only picks up deliveries still in the queue — so nothing picked up the
 * 10,532,688.35 $CMC that purchase brought. They sat on the keeper until they
 * were sent by hand on 2026-09-28.
 *
 * The delivery rounds cannot know what a second pass will still buy. So once
 * the buying is over, and before the sweep, every coin is settled from what was
 * actually bought:
 *
 *   1. the burn is brought up to what is owed (a coin still refusing for a
 *      reason its authority could lift is marked blocked here);
 *   2. every wallet whose share of the tokens is more than it has received gets
 *      a top-up delivery in the queue. The sweep that runs next sends it, with
 *      the same care as any other: the amount is worked out at sending time and
 *      a pending signature is looked up before anything goes twice.
 *
 * Everything is derived from the round's state, so running it again — after a
 * crash, say — adds nothing that is already there.
 */

import { Keypair, PublicKey } from "@solana/web3.js";

import { Logger, logger as rootLogger } from "../logger";
import { TX_FEE_SOL } from "../scheduler/fees";
import { burnDueFor, BurnDeps } from "./burns";
import { BatchLoader, refreshPurchaseTokens, tokensBought } from "./purchaseTokens";
import { deliveryOwed, hasBurn, sharesOf, totalStake } from "./shares";
import { sentFromKeeper } from "./sendRounds";
import { OrchestratorStateManager } from "./state";
import { SendRecord } from "./types";
import { signatureOutcome, SignatureOutcome } from "../solana/signatureOutcome";

/**
 * A top-up is sent only if it is worth at least this much at the coin's average
 * purchase price: the fee ceiling of the delivery that carries it. Anything
 * smaller would cost more to send than it is worth, and stays on the keeper as
 * dust. Anything larger is somebody's tokens, and goes.
 *
 * Round 1790348400190 is why it is not higher: the smaller of its two
 * shortfalls, 453,560,742,144 raw, was worth about 0.000027 SOL — under a
 * 0.0001 threshold, and still three times what its delivery cost.
 */
export const TOP_UP_MIN_SOL = TX_FEE_SOL;

/** Pauses between attempts to read the last purchases, which may have just landed. */
const READ_RETRY_DELAYS_MS = [0, 2_000, 5_000, 10_000];

export interface SettleParams {
    stateManager: OrchestratorStateManager;
    keeper: Keypair;
    sendRounds: number;
    loadBatch: BatchLoader;
    /** The keeper's balance of a coin; only used for coins nobody burns. */
    tokenBalance: (mint: PublicKey) => Promise<bigint>;
    sleepFn: (ms: number) => Promise<void>;
    logger?: Logger;
    /** Overrides for tests. */
    burnDeps?: Partial<BurnDeps>;
    readDeps?: Parameters<typeof refreshPurchaseTokens>[4];
    signatureOutcome?: (signature: string, lastValidBlockHeight?: number) => Promise<SignatureOutcome>;
}

export interface SettleResult {
    topUps: number;
    /** Coins whose burn could not be finished yet, or whose purchases are not all read. */
    burnsWaiting: string[];
}

export async function settleAfterBuying(params: SettleParams): Promise<SettleResult> {
    const { stateManager, keeper, sendRounds, loadBatch, tokenBalance, sleepFn } = params;
    const log = params.logger ?? rootLogger;
    const state = stateManager.getState();
    const mints = (state.tokenBuys ?? []).map((token) => token.mint);
    const exact = mints.filter((mint) => hasBurn(sharesOf(state, mint)));

    // 1. What the purchases brought. The last ones may have landed a moment
    // ago and a lagging node may not have them yet, hence the retries.
    for (const delay of READ_RETRY_DELAYS_MS) {
        const unread = exact.filter((mint) => tokensBought(stateManager.getState(), mint, loadBatch).unread.length > 0);
        if (unread.length === 0) {
            break;
        }
        if (delay > 0) {
            await sleepFn(delay);
        }
        await refreshPurchaseTokens(stateManager, keeper.publicKey, unread, loadBatch, { logger: log, ...params.readDeps });
    }

    // A confirmed purchase the node still cannot return is left out of B, so
    // its burn share and its backers' shares are not settled now. The burn is
    // finished after the sweep; the deliveries are not topped up again.
    const incomplete = exact.filter((mint) => tokensBought(stateManager.getState(), mint, loadBatch).unread.length > 0);
    for (const mint of incomplete) {
        log.error({ event: "settle.basis_incomplete", mint: mint.slice(0, 8) },
            "Some purchases of this coin could not be read; its deliveries are settled on what is known");
    }

    // 2. The burn, final.
    const burnsWaiting: string[] = [...incomplete];
    for (const mint of exact) {
        if (stateManager.getTokenBuy(mint)?.burnBlocked) {
            continue;
        }
        const result = await burnDueFor(stateManager, keeper, mint, { logger: log, loadBatch, ...params.burnDeps }, true);
        if (result === "waiting" && !burnsWaiting.includes(mint)) {
            burnsWaiting.push(mint);
        }
    }

    // 3. Top-ups.
    let topUps = 0;
    for (const mint of mints) {
        const added = await topUpsFor(
            stateManager, mint, exact.includes(mint), sendRounds, loadBatch, tokenBalance,
            params.signatureOutcome ?? signatureOutcome, log
        );
        topUps += added;
    }

    if (topUps > 0) {
        log.warn({ event: "lottery.settle_top_ups", count: topUps },
            `Settlement: ${topUps} wallet(s) had not received their full share`);
    }
    return { topUps, burnsWaiting };
}

/**
 * Pauses before each last attempt at a burn that is still waiting. A burn waits
 * when its previous transaction might still land, and that is settled by the
 * chain moving past the transaction's blockhash, a minute or two at most.
 */
export const FINISH_BURN_DELAYS_MS = [0, 30_000, 60_000, 120_000];

/**
 * The last word on burns, after the sweep.
 *
 * Settlement burns once; a burn that could not be settled there (its previous
 * transaction's fate unknown) is tried again here, with pauses, because the
 * round is about to close and nothing would come back to it. What is still
 * waiting at the end is logged as an error: the tokens stay on the keeper and
 * the burn has to be finished by hand.
 */
export async function finishBurns(params: {
    stateManager: OrchestratorStateManager;
    keeper: Keypair;
    mints: string[];
    loadBatch: BatchLoader;
    sleepFn: (ms: number) => Promise<void>;
    logger?: Logger;
    burnDeps?: Partial<BurnDeps>;
    readDeps?: Parameters<typeof refreshPurchaseTokens>[4];
    delaysMs?: number[];
}): Promise<string[]> {
    const { stateManager, keeper, loadBatch, sleepFn } = params;
    const log = params.logger ?? rootLogger;
    let waiting = [...params.mints];
    for (const delay of params.delaysMs ?? FINISH_BURN_DELAYS_MS) {
        if (waiting.length === 0) {
            break;
        }
        if (delay > 0) {
            await sleepFn(delay);
        }
        await refreshPurchaseTokens(stateManager, keeper.publicKey, waiting, loadBatch, { logger: log, ...params.readDeps });
        const still: string[] = [];
        for (const mint of waiting) {
            const result = await burnDueFor(stateManager, keeper, mint, { logger: log, loadBatch, ...params.burnDeps }, true);
            const unread = tokensBought(stateManager.getState(), mint, loadBatch).unread.length > 0;
            if (result === "waiting" || (unread && result !== "blocked")) {
                still.push(mint);
            }
        }
        waiting = still;
    }
    for (const mint of waiting) {
        log.error({ event: "burn.unfinished", mint: mint.slice(0, 8) },
            `The burn of ${mint.slice(0, 8)} could not be finished; its share stays on the keeper`);
    }
    return waiting;
}

async function topUpsFor(
    stateManager: OrchestratorStateManager,
    mint: string,
    exact: boolean,
    sendRounds: number,
    loadBatch: BatchLoader,
    tokenBalance: (mint: PublicKey) => Promise<bigint>,
    outcome: (signature: string, lastValidBlockHeight?: number) => Promise<SignatureOutcome>,
    log: Logger
): Promise<number> {
    const state = stateManager.getState();
    const sends = state.sends.filter((send) => send.mint === mint);
    if (sends.length === 0) {
        return 0;
    }

    // A delivery given up after its last attempt can still hold a signature
    // that nobody looked up: the attempt ran out of time, not necessarily of
    // luck. Counting it as undelivered would top the wallet up while the tokens
    // may already be there, and the second delivery comes out of everybody
    // else's share. So it is settled first; if the chain cannot say, the
    // wallet is left alone.
    const unsure = new Set<string>();
    for (const send of sends) {
        if (send.status !== "abandoned" || !send.pendingSignature) {
            continue;
        }
        const verdict = await outcome(send.pendingSignature, send.pendingLastValidBlockHeight);
        if (verdict === "landed") {
            stateManager.updateSend(send.id, {
                status: "completed",
                signature: send.pendingSignature,
                pendingSignature: undefined,
                pendingLastValidBlockHeight: undefined,
                grossAmount: send.amount,
            });
            stateManager.incrementMetric("send.pendingTxConfirmed");
            log.info({ event: "settle.abandoned_send_landed", sendId: send.id }, "A delivery given up had landed after all");
        } else if (verdict === "unknown") {
            unsure.add(send.recipient);
        }
    }
    const shares = sharesOf(state, mint);
    const stake = totalStake(shares);
    if (stake === 0n) {
        return 0;
    }

    // Delivered so far, per wallet, counted the way the deficit logic counts
    // it: what left the keeper where the basis is exact, what arrived otherwise.
    const delivered = new Map<string, bigint>();
    for (const send of sends) {
        if (send.status === "completed" && send.amount) {
            const counted = exact ? sentFromKeeper(send) : BigInt(send.amount);
            delivered.set(send.recipient, (delivered.get(send.recipient) ?? 0n) + counted);
        }
    }

    // What the coin's tokens add up to. Exact where somebody burns; for the
    // rest the pot is inferred exactly as the delivery rounds always have —
    // what the keeper holds plus what has gone out — so a coin nobody burns is
    // settled by the same arithmetic it was delivered by.
    let bought: bigint;
    if (exact) {
        bought = tokensBought(state, mint, loadBatch).known;
    } else {
        let balance: bigint;
        try {
            balance = await tokenBalance(new PublicKey(mint));
        } catch {
            log.warn({ event: "settle.balance_unreadable", mint: mint.slice(0, 8) }, "Balance unreadable; no top-ups for this coin now");
            return 0;
        }
        const sent = [...delivered.values()].reduce((sum, value) => sum + value, 0n);
        bought = balance + sent;
    }
    if (bought <= 0n) {
        return 0;
    }

    const token = stateManager.getTokenBuy(mint);
    const spentSol = token?.spentSol ?? 0;
    const solPerRaw = spentSol > 0 ? spentSol / Number(bought) : 0;

    const busy = new Set([
        ...sends.filter((send) => send.status === "pending" || send.status === "in_progress").map((send) => send.recipient),
        ...unsure,
    ]);
    const added: SendRecord[] = [];
    const now = Date.now();
    let counter = state.sends.length;

    for (const wallet of new Set(sends.map((send) => send.recipient))) {
        if (busy.has(wallet)) {
            // Already queued: the sweep works its amount out from the same total.
            continue;
        }
        const target = exact
            ? deliveryOwed(bought, wallet, shares)
            : (bought * (shares.find((share) => share.wallet === wallet)?.stake ?? 0n)) / stake;
        const short = target - (delivered.get(wallet) ?? 0n);
        if (short <= 0n) {
            continue;
        }
        if (solPerRaw > 0 && Number(short) * solPerRaw < TOP_UP_MIN_SOL) {
            continue;
        }
        const sample = sends.find((send) => send.recipient === wallet)!;
        counter += 1;
        added.push({
            id: `send_topup_${counter}`,
            mint,
            recipient: wallet,
            recipientBetSol: sample.recipientBetSol,
            share: sample.share,
            sendN: 1,
            round: sendRounds,
            status: "pending",
            topUp: true,
            attempts: 0,
            hadAtaAtStart: sample.hadAtaAtStart,
            updatedAt: now,
        });
        log.info({ event: "settle.top_up", mint: mint.slice(0, 8), wallet: wallet.slice(0, 8), short: short.toString() },
            "Queued a top-up");
    }

    stateManager.addSends(added);
    return added.length;
}
