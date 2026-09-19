// api/purchaseFeed.ts
// The purchase feed for one round: what has been bought and in which transactions.
//
// The site shows it while the buying runs — a promise you can see on chain is
// the whole product. So only completed purchases with a signature reach the
// feed: an unfinished one proves nothing.
//
// Building it is kept out of the route as its own function, so it can be
// tested without the network and without files.

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
}

export interface PurchaseFeedItem {
    mint: string;
    index: number;
    solAmount: number;
    signature: string;
    venue?: string;
    at: number;
}

export interface PurchaseFeed {
    lotteryId: string;
    summary: LotteryState["summary"];
    tokens: PurchaseFeedToken[];
    purchases: PurchaseFeedItem[];
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

        tokens.push({
            mint: token.mint,
            status: token.status,
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

    return {
        lotteryId: state.lotteryId,
        summary: state.summary,
        tokens,
        purchases: purchases.slice(0, MAX_FEED_PURCHASES),
        totals: {
            targetSol: round(tokens.reduce((sum, token) => sum + (token.targetSol || 0), 0)),
            spentSol: round(tokens.reduce((sum, token) => sum + (token.spentSol || 0), 0)),
            plannedPurchases: tokens.reduce((sum, token) => sum + token.plannedPurchases, 0),
            completedPurchases: tokens.reduce((sum, token) => sum + token.completedPurchases, 0),
        },
    };
}

/** SOL to nine decimals: summing floats otherwise gives tails like 12.300000000000001. */
function round(value: number): number {
    return Math.round(value * 1e9) / 1e9;
}
