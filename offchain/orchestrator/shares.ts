// orchestrator/shares.ts
// Who gets what of a coin's tokens, and how much of it is burned.

/**
 * The rule, which is the whole promise of the burn option:
 *
 *   delivered to i = B × s_i × (10000 − bps_i) / (S × 10000)
 *   burned         = B × Σ(s_i × bps_i)      / (S × 10000)
 *
 * B is every token bought for the coin, s_i one wallet's commit, S all commits
 * behind the coin — burners included — and bps_i the share that wallet asked to
 * have burned. So what a wallet receives depends on its own commit and its own
 * choice and on nothing anybody else chose: someone asking for 50% gets exactly
 * half of their share whether the others burn nothing or everything.
 *
 * Checked two ways before a line of this was written: by the algebra above, and
 * by simulating 400 random rounds through the real delivery scheduling
 * (`docs/burn-delivery-simulation.py`): no broken promise, worst error 6.6e-10,
 * at most 9 raw units of dust. The same checker run on the old formula, which
 * divided the remaining balance by commits alone, broke the promise in 363 of
 * the 400 — which is what makes the zero mean something.
 *
 * Everything is bigint: raw token units times lamports times basis points
 * overflow a double long before they overflow anything we deal in.
 */

import { LotteryState, RecipientStake } from "./types";

export const FULL_BPS = 10_000n;

export interface Share {
    wallet: string;
    /** Lamports committed. */
    stake: bigint;
    /** Σ(lamports × bps) over the wallet's commits: 0 for none, stake × 10000 for all of it. */
    burn: bigint;
}

/**
 * A wallet's burn weight from what the round was given: the exact figure when
 * there is one, otherwise the commit times its basis points. Never below zero,
 * never more than all of the commit.
 */
export function burnWeightOf(stake: bigint, burnWeight?: string, burnBps?: number): bigint {
    const all = stake * FULL_BPS;
    let weight: bigint;
    if (typeof burnWeight === "string" && /^\d+$/.test(burnWeight)) {
        weight = BigInt(burnWeight);
    } else {
        const bps = typeof burnBps === "number" && Number.isFinite(burnBps)
            ? Math.max(0, Math.min(10_000, Math.round(burnBps)))
            : 0;
        weight = stake * BigInt(bps);
    }
    if (weight < 0n) {
        return 0n;
    }
    return weight > all ? all : weight;
}

/**
 * Who stood behind a coin.
 *
 * From the round's own record when it has one. Older rounds, started before the
 * burn existed, have only their deliveries: the commits are read from those and
 * nobody burns. A wallet listed twice is one wallet: its commits and its burn
 * weights add up.
 */
export function sharesOf(state: LotteryState, mint: string): Share[] {
    const token = (state.tokenBuys ?? []).find((t) => t.mint === mint);
    const byWallet = new Map<string, Share>();
    if (token?.recipients && token.recipients.length > 0) {
        for (const recipient of token.recipients) {
            const share = fromStake(recipient);
            if (share.stake <= 0n) {
                continue;
            }
            const prev = byWallet.get(share.wallet);
            byWallet.set(share.wallet, prev
                ? { wallet: share.wallet, stake: prev.stake + share.stake, burn: prev.burn + share.burn }
                : share);
        }
        return [...byWallet.values()];
    }
    for (const send of state.sends ?? []) {
        if (send.mint !== mint || byWallet.has(send.recipient)) {
            continue;
        }
        const stake = BigInt(Math.round(send.recipientBetSol * 1e9));
        if (stake > 0n) {
            byWallet.set(send.recipient, { wallet: send.recipient, stake, burn: 0n });
        }
    }
    return [...byWallet.values()];
}

function fromStake(recipient: RecipientStake): Share {
    const stake = /^\d+$/.test(recipient.stakeLamports ?? "") ? BigInt(recipient.stakeLamports) : 0n;
    return { wallet: recipient.wallet, stake, burn: burnWeightOf(stake, recipient.burnWeight, recipient.burnBps) };
}

export function totalStake(shares: Share[]): bigint {
    return shares.reduce((sum, share) => sum + share.stake, 0n);
}

/** Whether anybody behind the coin asked for a burn. */
export function hasBurn(shares: Share[]): boolean {
    return shares.some((share) => share.burn > 0n && share.stake > 0n);
}

/** Σ(s_i × bps_i): the numerator of the coin's burn share. */
function burnWeight(shares: Share[]): bigint {
    return shares.reduce((sum, share) => sum + share.burn, 0n);
}

/** How much of `bought` is owed to the fire, rounded down. */
export function burnOwed(bought: bigint, shares: Share[]): bigint {
    const denominator = totalStake(shares) * FULL_BPS;
    if (bought <= 0n || denominator === 0n) {
        return 0n;
    }
    return (bought * burnWeight(shares)) / denominator;
}

/** How much of `bought` is owed to one wallet, rounded down. */
export function deliveryOwed(bought: bigint, wallet: string, shares: Share[]): bigint {
    const denominator = totalStake(shares) * FULL_BPS;
    const share = shares.find((s) => s.wallet === wallet);
    if (!share || bought <= 0n || denominator === 0n) {
        return 0n;
    }
    return (bought * (share.stake * FULL_BPS - share.burn)) / denominator;
}

/** The coin's burn share in basis points, commit-weighted, for display. */
export function averageBurnBps(shares: Share[]): number {
    const total = totalStake(shares);
    if (total === 0n) {
        return 0;
    }
    return Number((burnWeight(shares) * 100n) / total) / 100;
}
