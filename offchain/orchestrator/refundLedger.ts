// orchestrator/refundLedger.ts
// What each coin was given and what it actually cost.

/**
 * The refund answers one question: of the SOL allocated to this coin, how much
 * never reached the market? Both halves of that were wrong.
 *
 * **What was spent** was the sum of the planned purchase amounts. What leaves
 * the wallet is that plus the fee, plus the priority, plus the rent of any
 * account the transaction had to create. All three are reserved for up front —
 * `calculateFees` holds back the token account and twice the priority ceiling
 * per purchase — and that reserve is precisely what got refunded: with the
 * spend counted from the plan, every lamport held back looked unspent whether
 * it had been used or not. Round 1790348400190, 29 purchases: planned
 * 10.124230, actually taken 10.126363, and the 0.002133 difference went back to
 * people as though it were still there.
 *
 * **What was allocated** was a share of `buyBudget`, the pool minus the
 * delivery reserve. That reserve is the pool's money too, and delivery used
 * 0.003053 of the 0.004140 held back. The remaining 0.001087 stayed on the
 * keeper for good, which is the same mistake pointing the other way.
 *
 * On that round the two nearly cancelled and the keeper still ended 0.000696
 * SOL down; with this it ends 0.000305 up, which is exactly the one share too
 * small to be worth a transaction. The sizes are small and the sign is what
 * matters: the keeper's balance is what buys the next round, and `insufficient
 * funds` is not a retryable error.
 *
 * So the spend is read from the chain by `readKeeperDebits`, and the delivery
 * reserve is settled **as a pool, not per coin**. That second part is not a
 * detail. Delivery costs what the recipients cost — about 0.0015 of rent for
 * every wallet that has never held the coin — while a coin's allocation is its
 * share of the draw. A coin drawn small but backed by eight people costs more
 * to deliver than it was given, and charging that to the coin alone would
 * leave the keeper covering the difference while every other coin refunded its
 * own unused reserve away. Worked through on a 35 SOL round with five coins:
 * per coin the keeper ends 0.0077 down, pooled it ends level.
 *
 * Where the chain could not be read the spend is estimated upwards. Refunding
 * a few lamports too little leaves them on the keeper; refunding too much is
 * the bug this fixes.
 */

import { ATA_FEE_SOL, BUY_TX_FEE_SOL, TX_FEE_SOL } from "../scheduler/fees";
import { BatchState } from "../scheduler/types";
import { Debit } from "../solana/debits";
import { LotteryState, SendRecord, TokenBuyRecord } from "./types";

/** What a coin's refund is worked out from. */
export interface RefundBasis {
    /** What the buying of this coin was given: its share of the pool, less the delivery reserve. */
    allocatedSol: number;
    /** Every lamport the keeper paid buying it. */
    spentSol: number;
    /** This coin's share of whatever the delivery reserve did not use. */
    deliveryLeftoverSol: number;
    /** True when every figure above came from the chain rather than an estimate. */
    exact: boolean;
}

/** What the round did with the money it held back for delivery. */
export interface DeliverySettlement {
    reserveSol: number;
    spentSol: number;
    /** Kept back for deliveries that have not finished: a later pass needs the fee. */
    heldSol: number;
    /** What is left to give back, never less than nothing. */
    leftoverSol: number;
    exact: boolean;
}

/** Statuses of a delivery that something will still try to pay for. */
const UNFINISHED_SEND_STATUSES = new Set(["pending", "in_progress"]);

export type BatchLoader = (filePath?: string) => BatchState | null;

/**
 * Every signature this round may have been charged for.
 *
 * Both the confirmed signature and the one left pending: a transaction that
 * expired before it landed costs nothing, and one that landed and failed still
 * paid its fee. We do not know which from here, so we ask about both and let
 * the chain say.
 */
export function collectRoundSignatures(state: LotteryState, loadBatch: BatchLoader): string[] {
    const signatures: string[] = [];

    for (const token of state.tokenBuys ?? []) {
        for (const batch of batchesOf(token, loadBatch)) {
            for (const purchase of batch.purchases ?? []) {
                if (purchase.signature) signatures.push(purchase.signature);
                if (purchase.pendingSignature) signatures.push(purchase.pendingSignature);
                for (const attempt of purchase.sentAttempts ?? []) signatures.push(attempt.signature);
            }
        }
    }

    for (const send of state.sends ?? []) {
        if (send.signature) signatures.push(send.signature);
        if (send.pendingSignature) signatures.push(send.pendingSignature);
        for (const failed of send.failedSignatures ?? []) signatures.push(failed);
    }

    for (const burn of state.burns ?? []) {
        if (burn.signature) signatures.push(burn.signature);
        if (burn.pendingSignature) signatures.push(burn.pendingSignature);
    }

    return [...new Set(signatures)];
}

/**
 * The basis for every coin's refund.
 *
 * Pure: it takes the debits already read and returns arithmetic, so the whole
 * of it can be checked against a real round without touching the network.
 */
export function buildRefundLedger(
    state: LotteryState,
    loadBatch: BatchLoader,
    debits: Map<string, Debit>
): Map<string, RefundBasis> {
    const delivery = settleDelivery(state, debits);
    const ledger = new Map<string, RefundBasis>();

    // The leftover of the delivery reserve goes back the way it was taken: by
    // the size of each coin's allocation.
    const totalAllocated = (state.tokenBuys ?? []).reduce(
        (sum, token) => sum + Math.max(0, token.adjustedSolAmount),
        0
    );

    for (const token of state.tokenBuys ?? []) {
        const share = totalAllocated > 0
            ? (delivery.leftoverSol * Math.max(0, token.adjustedSolAmount)) / totalAllocated
            : 0;
        const bought = buySpend(token, loadBatch, debits);

        ledger.set(token.mint, {
            allocatedSol: round9(token.adjustedSolAmount),
            spentSol: round9(bought.spentSol),
            deliveryLeftoverSol: round9(share),
            exact: bought.exact && delivery.exact,
        });
    }

    return ledger;
}

/** What buying one coin took from the keeper. */
function buySpend(
    token: TokenBuyRecord,
    loadBatch: BatchLoader,
    debits: Map<string, Debit>
): { spentSol: number; exact: boolean } {
    const batches = batchesOf(token, loadBatch);
    // No batch file, no signatures: we cannot tell what was really paid, so we
    // fall back to what the old rule used, the planned figures. It under-refunds
    // rather than over-refunds, which is the direction to be wrong in.
    if (batches.length === 0) {
        return { spentSol: token.spentSol ?? 0, exact: false };
    }

    let spent = 0;
    let exact = true;

    for (const batch of batches) {
        const createsAta = batch.config?.hadAtaAtStart !== true;
        let firstCompleted = true;

        for (const purchase of batch.purchases ?? []) {
            if (purchase.status === "completed" && purchase.signature) {
                const debit = debits.get(purchase.signature);
                if (typeof debit === "number" && debit > 0) {
                    spent += debit;
                } else {
                    // The reserve for one attempt is the ceiling of what a
                    // purchase can cost, so it is the estimate that cannot be
                    // too low. The token account is added to the first purchase
                    // of a batch that had to create one.
                    spent += purchase.solAmount + BUY_TX_FEE_SOL + (createsAta && firstCompleted ? ATA_FEE_SOL : 0);
                    exact = false;
                }
                firstCompleted = false;
            }

            // An earlier attempt at the same purchase, whatever became of the
            // purchase in the end. A transaction that reached the chain and
            // failed there is still charged for; one that expired on the way
            // never was, and the chain answers zero for it. This has to be
            // asked even about a purchase that succeeded, or a first attempt
            // that quietly landed would go uncounted — and that one did not
            // only pay a fee, it bought.
            //
            // Every attempt counts, not only the last: a purchase signed again
            // after its blockhash ran out sent several, and one that landed and
            // failed paid its fee whichever attempt it was.
            const earlier = new Set<string>();
            if (purchase.pendingSignature) earlier.add(purchase.pendingSignature);
            for (const attempt of purchase.sentAttempts ?? []) earlier.add(attempt.signature);
            if (purchase.signature) earlier.delete(purchase.signature);
            for (const signature of earlier) {
                const debit = debits.get(signature);
                if (typeof debit === "number") {
                    spent += debit;
                } else {
                    spent += BUY_TX_FEE_SOL;
                    exact = false;
                }
            }
        }
    }

    return { spentSol: spent, exact };
}

/**
 * The delivery reserve against what delivery actually cost.
 *
 * One sum for the whole round. The reserve was taken from the whole pool and
 * it pays for whichever wallets turn out to need a token account; tying it to
 * individual coins would leave the keeper covering the ones whose recipients
 * cost more than their share of the draw.
 */
export function settleDelivery(state: LotteryState, debits: Map<string, Debit>): DeliverySettlement {
    const sends = state.sends ?? [];
    // Up to five recipients share one transaction, so the same signature
    // appears on several records. Counting it once per record would charge the
    // round four times over for a delivery it paid for once.
    const seen = new Set<string>();
    let spent = 0;
    let exact = true;

    // A recipient whose token account had to be made pays its rent once, on
    // whichever delivery reached them first — never once per transaction.
    // Where a debit was read the rent is already inside it, so it is only the
    // recipients we know nothing about who need it added.
    const rentKnown = new Set<string>();
    for (const send of sends) {
        for (const signature of [send.signature, send.pendingSignature]) {
            if (signature && typeof debits.get(signature) === "number") {
                rentKnown.add(send.recipient);
            }
        }
    }

    for (const send of sends) {
        for (const signature of [send.signature, send.pendingSignature, ...(send.failedSignatures ?? [])]) {
            if (!signature || seen.has(signature)) {
                continue;
            }
            seen.add(signature);
            const debit = debits.get(signature);
            if (typeof debit === "number") {
                spent += debit;
                continue;
            }
            spent += TX_FEE_SOL;
            exact = false;
        }
    }

    const rentOwed = new Set(
        sends
            .filter((send) => send.hadAtaAtStart === false && !rentKnown.has(send.recipient))
            .map((send) => send.recipient)
    );
    spent += rentOwed.size * ATA_FEE_SOL;

    // Burns are paid for from the same reserve (`burnReserve` in the
    // orchestrator). A burn creates no account, so a debit is its fee and
    // priority and nothing else; unread, it is estimated at the ceiling.
    const burns = state.burns ?? [];
    for (const burn of burns) {
        for (const signature of [burn.signature, burn.pendingSignature]) {
            if (!signature || seen.has(signature)) {
                continue;
            }
            seen.add(signature);
            const debit = debits.get(signature);
            if (typeof debit === "number") {
                spent += debit;
                continue;
            }
            spent += TX_FEE_SOL;
            exact = false;
        }
    }

    const reserve = Math.max(0, state.sendReserve ?? 0);
    // A burn still open may have to be sent again by whoever finishes it.
    const held = holdForUnfinishedSends(sends)
        + burns.filter((burn) => burn.status === "in_progress").length * TX_FEE_SOL;

    return {
        reserveSol: round9(reserve),
        spentSol: round9(spent),
        heldSol: round9(held),
        leftoverSol: round9(Math.max(0, reserve - spent - held)),
        exact,
    };
}

/**
 * Money that must not be refunded yet.
 *
 * A delivery still in the queue when the refund runs will be tried again by
 * the next recovery pass, and that pass needs the fee. Refunding it now would
 * mean the keeper paying for someone else's tokens later. A delivery that
 * failed is not held for: by this point every sweep is over and it is marked
 * abandoned moments later, and the refund is worked out once.
 */
function holdForUnfinishedSends(sends: SendRecord[]): number {
    const unfinished = sends.filter((send) => UNFINISHED_SEND_STATUSES.has(send.status));
    if (unfinished.length === 0) {
        return 0;
    }

    const delivered = new Set(
        sends.filter((send) => send.status === "completed").map((send) => send.recipient)
    );
    const needsAta = new Set(
        unfinished
            .filter((send) => send.hadAtaAtStart === false && !delivered.has(send.recipient))
            .map((send) => send.recipient)
    );

    return unfinished.length * TX_FEE_SOL + needsAta.size * ATA_FEE_SOL;
}

function batchesOf(
    token: { batchStateFile?: string; batchStateFiles?: string[] },
    loadBatch: BatchLoader
): BatchState[] {
    const files = token.batchStateFiles?.length
        ? token.batchStateFiles
        : token.batchStateFile
            ? [token.batchStateFile]
            : [];
    return files
        .map((file) => loadBatch(file))
        .filter((batch): batch is BatchState => !!batch);
}

function round9(value: number): number {
    return Math.round(value * 1e9) / 1e9;
}
