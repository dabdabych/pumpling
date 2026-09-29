// api/purchaseFeed.ts
// The purchase feed for one round: what has been bought and in which transactions.
//
// The site shows it while the buying runs — a promise you can see on chain is
// the whole product. So only completed purchases with a signature reach the
// feed: an unfinished one proves nothing.
//
// Building it is kept out of the route as its own function, so it can be
// tested without the network and without files.

import { tokensBought } from "../orchestrator/purchaseTokens";
import { averageBurnBps, burnOwed, hasBurn, sharesOf } from "../orchestrator/shares";
import { LotteryState } from "../orchestrator/types";
import { BatchState, PurchaseRecord } from "../scheduler/types";

/** How many purchases to return: a feed, not an archive. */
export const MAX_FEED_PURCHASES = 200;

export interface PurchaseFeedToken {
    mint: string;
    status: string;
    targetSol: number;
    spentSol: number;
    plannedPurchases: number;
    completedPurchases: number;
    startedAt?: number;
    finishedAt?: number;
    /** The mint's decimals, when the buyer read them: every raw figure below is in them. */
    decimals?: number;
    /** The coin's burn share, commit-weighted, in basis points. Zero when nobody burns. */
    burnBps: number;
    /** Only for a coin with burners — see `PurchaseFeedBurn`. */
    burn?: PurchaseFeedBurn;
}

/**
 * Where a coin's burn stands. Raw units, decimal strings: they do not fit a
 * double.
 *
 * `owedRaw` is what is owed for what has been bought so far. While the buying
 * runs it grows with every purchase; the promise is a share, not a number, and
 * the page says so.
 */
export interface PurchaseFeedBurn {
    /** Every token the purchases brought, read from their own transactions. */
    boughtRaw: string;
    owedRaw: string;
    burnedRaw: string;
    /** Why burning stopped, if it did. The unburned share stays on the keeper. */
    blockedReason?: string;
    supplyAtStart?: string;
    supplyAtEnd?: string;
}

/** One delivery transaction: up to five wallets, one signature. */
export interface DeliveryFeedItem {
    mint: string;
    signature: string;
    /** What arrived, summed over the wallets in this transaction. */
    rawAmount: string;
    recipients: string[];
    at: number;
}

export interface BurnFeedItem {
    mint: string;
    signature: string;
    rawAmount: string;
    at: number;
}

/**
 * Unspent SOL going back to the people behind a coin: one row per transaction
 * and coin. A refund transaction carries up to eight transfers and can mix
 * coins; each coin's part is its own row, so the coin column stays true.
 */
export interface RefundFeedItem {
    mint: string;
    signature: string;
    /** What arrived, summed over the wallets in this transaction for this coin. */
    sol: number;
    recipients: string[];
    at: number;
}

export interface PurchaseFeedItem {
    mint: string;
    index: number;
    solAmount: number;
    signature: string;
    venue?: string;
    at: number;
}

/**
 * What the buyer is doing.
 *
 *  - `buying`: the main window, every coin on its own schedule.
 *  - `fallback`: the main window is over and something did not go through, so
 *    the coins that came up short are being bought again. Up to fifteen
 *    minutes, sized by how many purchases have to be repeated.
 *  - `finished`: every coin is done and nothing more will be bought.
 *
 * The site needs the difference. A round in its second pass is still buying and
 * has its own deadline; a round that finished early should not leave people
 * watching a countdown with nothing happening behind it.
 */
export type BuyPhase = "buying" | "fallback" | "finished";

export interface PurchaseFeed {
    lotteryId: string;
    summary: LotteryState["summary"];
    phase: BuyPhase;
    /** When the second pass runs out. Only while `phase` is `fallback`. */
    fallbackEndsAt?: number;
    tokens: PurchaseFeedToken[];
    purchases: PurchaseFeedItem[];
    /** Newest first, at most `MAX_FEED_PURCHASES`. */
    deliveries: DeliveryFeedItem[];
    /** Newest first, at most `MAX_FEED_PURCHASES`. */
    burns: BurnFeedItem[];
    /** Newest first, at most `MAX_FEED_PURCHASES`. */
    refunds: RefundFeedItem[];
    totals: {
        targetSol: number;
        spentSol: number;
        plannedPurchases: number;
        completedPurchases: number;
    };
}

export type BatchLoader = (filePath?: string) => BatchState | null;

export function buildPurchaseFeed(state: LotteryState, loadBatch: BatchLoader): PurchaseFeed {
    const tokens: PurchaseFeedToken[] = [];
    const purchases: PurchaseFeedItem[] = [];
    // Collected while we walk the coins.
    let buying = 0;
    let fallbackEndsAt = 0;

    for (const token of state.tokenBuys ?? []) {
        // A coin can have several batches: after a recovery a new one buys the
        // remainder while the earlier one holds the purchases already made,
        // with their signatures. The feed has to show them all, or what was
        // bought would "disappear".
        const files = token.batchStateFiles?.length
            ? token.batchStateFiles
            : [token.batchStateFile];
        const batches = files
            .map((file) => loadBatch(file))
            .filter((batch): batch is BatchState => !!batch);

        const done = batches.flatMap((batch) =>
            (batch.purchases ?? []).filter(
                (purchase: PurchaseRecord) => purchase.status === "completed" && !!purchase.signature
            )
        );
        const startedAt = batches
            .map((batch) => batch.summary?.startedAt)
            .filter((value): value is number => typeof value === "number");
        const finishedAt = batches
            .map((batch) => batch.summary?.finishedAt)
            .filter((value): value is number => typeof value === "number");

        // A coin whose batch has no finish time is still being bought. One
        // that never got a batch at all is not: it failed before it started,
        // and waiting for it would leave the round buying for ever.
        const unfinished = batches.filter((batch) => batch.summary?.finishedAt === undefined);
        buying += unfinished.length;
        for (const batch of unfinished) {
            const endsAt = batch.summary?.retryEndsAt;
            if (typeof endsAt === "number" && endsAt > fallbackEndsAt) {
                fallbackEndsAt = endsAt;
            }
        }

        const shares = sharesOf(state, token.mint);
        let burn: PurchaseFeedBurn | undefined;
        if (hasBurn(shares)) {
            const bought = tokensBought(state, token.mint, loadBatch).known;
            burn = {
                boughtRaw: bought.toString(),
                owedRaw: burnOwed(bought, shares).toString(),
                burnedRaw: token.burnedRaw ?? "0",
                blockedReason: token.burnBlocked?.reason,
                supplyAtStart: token.supplyAtStart,
                supplyAtEnd: token.supplyAtEnd,
            };
        }

        tokens.push({
            mint: token.mint,
            status: token.status,
            decimals: token.decimals,
            burnBps: averageBurnBps(shares),
            burn,
            targetSol: token.adjustedSolAmount,
            spentSol: round(batches.reduce((sum, batch) => sum + (batch.summary?.totalSolSpent ?? 0), 0)),
            plannedPurchases: batches.reduce((sum, batch) => sum + (batch.purchaseCount ?? 0), 0),
            completedPurchases: done.length,
            startedAt: startedAt.length ? Math.min(...startedAt) : undefined,
            // There is a finish time only once every pass has been written out.
            finishedAt: finishedAt.length === batches.length && batches.length > 0 ? Math.max(...finishedAt) : undefined,
        });

        for (const purchase of done) {
            purchases.push({
                mint: token.mint,
                index: purchase.index,
                solAmount: purchase.solAmount,
                signature: purchase.signature as string,
                venue: purchase.venue,
                at: purchase.updatedAt,
            });
        }
    }

    // Newest first: the feed reads as events, not as a table.
    purchases.sort((a, b) => b.at - a.at || a.mint.localeCompare(b.mint) || b.index - a.index);

    const deliveries = deliveriesOf(state);
    const burns: BurnFeedItem[] = (state.burns ?? [])
        .filter((record) => record.status === "completed" && !!record.signature)
        .map((record) => ({
            mint: record.mint,
            signature: record.signature as string,
            rawAmount: record.rawAmount,
            at: record.updatedAt,
        }))
        .sort((a, b) => b.at - a.at || a.signature.localeCompare(b.signature));

    // "Finished" means nothing more will be bought — which is what both the
    // page and the round's own closing need to know. Refunds may still be
    // going out after it; they take no more of the pool.
    const finished = buying === 0 || state.summary?.finishedAt !== undefined;
    const phase: BuyPhase = finished ? "finished" : fallbackEndsAt > 0 ? "fallback" : "buying";

    return {
        lotteryId: state.lotteryId,
        summary: state.summary,
        phase,
        fallbackEndsAt: phase === "fallback" ? fallbackEndsAt : undefined,
        tokens,
        purchases: purchases.slice(0, MAX_FEED_PURCHASES),
        deliveries: deliveries.slice(0, MAX_FEED_PURCHASES),
        burns: burns.slice(0, MAX_FEED_PURCHASES),
        refunds: refundsOf(state).slice(0, MAX_FEED_PURCHASES),
        totals: {
            targetSol: round(tokens.reduce((sum, token) => sum + (token.targetSol || 0), 0)),
            spentSol: round(tokens.reduce((sum, token) => sum + (token.spentSol || 0), 0)),
            plannedPurchases: tokens.reduce((sum, token) => sum + token.plannedPurchases, 0),
            completedPurchases: tokens.reduce((sum, token) => sum + token.completedPurchases, 0),
        },
    };
}

/**
 * Completed deliveries, one row per transaction.
 *
 * Up to five wallets share a transaction, and the chain shows it as one; so
 * does the feed. A row is the sum of what arrived and who it arrived to.
 */
function deliveriesOf(state: LotteryState): DeliveryFeedItem[] {
    const bySignature = new Map<string, DeliveryFeedItem>();
    for (const send of state.sends ?? []) {
        if (send.status !== "completed" || !send.signature || !send.amount || !/^\d+$/.test(send.amount)) {
            continue;
        }
        const row = bySignature.get(send.signature);
        if (row) {
            row.rawAmount = (BigInt(row.rawAmount) + BigInt(send.amount)).toString();
            if (!row.recipients.includes(send.recipient)) {
                row.recipients.push(send.recipient);
            }
            row.at = Math.max(row.at, send.updatedAt);
            continue;
        }
        bySignature.set(send.signature, {
            mint: send.mint,
            signature: send.signature,
            rawAmount: send.amount,
            recipients: [send.recipient],
            at: send.updatedAt,
        });
    }
    return [...bySignature.values()].sort((a, b) => b.at - a.at || a.signature.localeCompare(b.signature));
}

/** Completed refunds, one row per transaction and coin. */
function refundsOf(state: LotteryState): RefundFeedItem[] {
    const rows = new Map<string, RefundFeedItem>();
    for (const refund of state.refunds ?? []) {
        if (refund.status !== "completed" || !refund.signature || !(refund.amountSol > 0)) {
            continue;
        }
        const key = `${refund.signature}:${refund.mint}`;
        const row = rows.get(key);
        if (row) {
            row.sol = round(row.sol + refund.amountSol);
            if (!row.recipients.includes(refund.recipient)) {
                row.recipients.push(refund.recipient);
            }
            row.at = Math.max(row.at, refund.updatedAt);
            continue;
        }
        rows.set(key, {
            mint: refund.mint,
            signature: refund.signature,
            sol: round(refund.amountSol),
            recipients: [refund.recipient],
            at: refund.updatedAt,
        });
    }
    return [...rows.values()].sort((a, b) => b.at - a.at || a.signature.localeCompare(b.signature) || a.mint.localeCompare(b.mint));
}

/** SOL to nine decimals: summing floats otherwise gives tails like 12.300000000000001. */
function round(value: number): number {
    return Math.round(value * 1e9) / 1e9;
}
