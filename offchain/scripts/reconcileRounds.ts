// scripts/reconcileRounds.ts
// Did every round deliver what it bought? Read from the chain, round by round.

/**
 * For every round state in a folder, and every coin in it:
 *
 *   bought    — what the round's purchases put on the keeper (every completed
 *               purchase and every earlier attempt that may have landed)
 *   delivered — what its deliveries took off the keeper
 *   burned    — what its burns took off the keeper
 *   residual  — bought − delivered − burned
 *
 * all from the transactions themselves, never from the state's own figures.
 * A residual above rounding dust is tokens that belong to somebody and never
 * reached them: the thing round 1790348400190 turned up. It is found here
 * rather than guessed at.
 *
 * Then, per coin across all rounds, the residuals are set against what the
 * keeper holds right now. The two need not match: a coin can be in several
 * rounds, and anything sent by hand (the 2026-09-28 delivery for that round)
 * is not in any state file. A difference is a question to answer, not a
 * verdict.
 *
 * Read only. It takes the keeper's public address, never its key.
 *
 *   node offchain/api/dist/scripts/reconcileRounds.js --keeper <address> [--dir ./logs] [--json] [--batch-size 25]
 *
 * (in the buyer container, whose image is built from offchain/api/tsconfig.json)
 *
 * A public node refuses big batches (HTTP 429); `--batch-size 1` gets through
 * slowly. Whatever still cannot be read is reported as INCOMPLETE, and such a
 * row is never called stranded.
 */

import * as fs from "fs";
import * as path from "path";
import { PublicKey } from "@solana/web3.js";

import { readBatchFile } from "../orchestrator/batchFile";
import { BatchLoader, completedPurchaseSignatures, pendingPurchaseSignatures } from "../orchestrator/purchaseTokens";
import { LotteryState } from "../orchestrator/types";
import { KeeperEffect, readKeeperEffects } from "../solana/debits";

export interface CoinReconciliation {
    lotteryId: string;
    mint: string;
    bought: bigint;
    delivered: bigint;
    burned: bigint;
    residual: bigint;
    /** Wallets behind the coin: the most dust a round can leave is about one raw unit each. */
    wallets: number;
    /** Completed purchases the node could not return: the figures above are incomplete. */
    unreadPurchases: number;
    /** Deliveries or burns whose transaction could not be read. */
    unreadTransfers: number;
}

/** Every signature one coin of one round could have moved tokens with. */
export function coinSignatures(state: LotteryState, mint: string, loadBatch: BatchLoader) {
    const token = (state.tokenBuys ?? []).find((t) => t.mint === mint);
    const completed = token ? completedPurchaseSignatures(token, loadBatch) : [];
    const earlier = token ? pendingPurchaseSignatures(token, loadBatch) : [];
    const deliveries = new Set<string>();
    for (const send of state.sends ?? []) {
        if (send.mint !== mint) {
            continue;
        }
        for (const signature of [send.signature, send.pendingSignature, ...(send.failedSignatures ?? [])]) {
            if (signature) {
                deliveries.add(signature);
            }
        }
    }
    const burns = new Set<string>();
    for (const burn of state.burns ?? []) {
        if (burn.mint !== mint) {
            continue;
        }
        for (const signature of [burn.signature, burn.pendingSignature]) {
            if (signature) {
                burns.add(signature);
            }
        }
    }
    return { completed, earlier: earlier.filter((s) => !completed.includes(s)), deliveries: [...deliveries], burns: [...burns] };
}

/** The reconciliation of one round, from effects already read. Pure. */
export function reconcileRound(
    state: LotteryState,
    loadBatch: BatchLoader,
    effects: Map<string, KeeperEffect>
): CoinReconciliation[] {
    const rows: CoinReconciliation[] = [];
    for (const token of state.tokenBuys ?? []) {
        const mint = token.mint;
        const signatures = coinSignatures(state, mint, loadBatch);
        const delta = (signature: string) => effects.get(signature)?.tokenDeltas.get(mint) ?? 0n;

        let bought = 0n;
        let unreadPurchases = 0;
        for (const signature of signatures.completed) {
            const effect = effects.get(signature);
            if (!effect || !effect.found) {
                unreadPurchases += 1;
                continue;
            }
            bought += delta(signature);
        }
        for (const signature of signatures.earlier) {
            // An earlier attempt not on chain simply never landed.
            bought += delta(signature) > 0n ? delta(signature) : 0n;
        }

        let unreadTransfers = 0;
        const out = (list: string[]) => {
            let sum = 0n;
            for (const signature of list) {
                if (!effects.has(signature)) {
                    unreadTransfers += 1;
                    continue;
                }
                const moved = delta(signature);
                sum += moved < 0n ? -moved : 0n;
            }
            return sum;
        };
        const delivered = out(signatures.deliveries);
        const burned = out(signatures.burns);

        const wallets = new Set([
            ...(token.recipients ?? []).map((r) => r.wallet),
            ...(state.sends ?? []).filter((s) => s.mint === mint).map((s) => s.recipient),
        ]).size;

        rows.push({
            lotteryId: state.lotteryId,
            mint,
            bought,
            delivered,
            burned,
            residual: bought - delivered - burned,
            wallets,
            unreadPurchases,
            unreadTransfers,
        });
    }
    return rows;
}

/**
 * Whether a residual is more than rounding can leave. Only said when every
 * transaction was read: with some missing, the figures prove nothing.
 */
export function isStranded(row: CoinReconciliation): boolean {
    return row.unreadPurchases === 0 && row.unreadTransfers === 0 && row.residual > BigInt(row.wallets + 2);
}

/** Reads the effects, asking again for what a busy node refused, with pauses. */
async function readAll(signatures: string[], keeper: PublicKey, batchSize: number): Promise<Map<string, KeeperEffect>> {
    const effects = new Map<string, KeeperEffect>();
    let missing = signatures;
    for (const pause of [0, 2_000, 5_000, 10_000, 20_000]) {
        if (missing.length === 0) {
            break;
        }
        if (pause > 0) {
            await new Promise((resolve) => setTimeout(resolve, pause));
        }
        const read = await readKeeperEffects(missing, keeper, { batchSize, logger: silentLogger });
        for (const [signature, effect] of read) {
            effects.set(signature, effect);
        }
        missing = missing.filter((signature) => !effects.has(signature));
    }
    return effects;
}

const silentLogger = { warn: () => undefined, info: () => undefined } as unknown as NonNullable<Parameters<typeof readKeeperEffects>[2]>["logger"];

// =============================================================================
// COMMAND LINE
// =============================================================================

async function currentBalances(keeper: PublicKey): Promise<Map<string, bigint>> {
    const { connection } = await import("../solana/connection");
    const balances = new Map<string, bigint>();
    const programs = [
        new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
        new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"),
    ];
    for (const programId of programs) {
        const accounts = await connection.getParsedTokenAccountsByOwner(keeper, { programId });
        for (const { account } of accounts.value) {
            const info = (account.data as { parsed?: { info?: { mint?: string; tokenAmount?: { amount?: string } } } }).parsed?.info;
            if (info?.mint && info.tokenAmount?.amount) {
                balances.set(info.mint, (balances.get(info.mint) ?? 0n) + BigInt(info.tokenAmount.amount));
            }
        }
    }
    return balances;
}

function argument(name: string): string | undefined {
    const index = process.argv.indexOf(`--${name}`);
    return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
    const keeperArg = argument("keeper");
    if (!keeperArg) {
        console.error("usage: reconcileRounds --keeper <address> [--dir ./logs] [--json]");
        process.exit(2);
    }
    const keeper = new PublicKey(keeperArg);
    const dir = argument("dir") ?? "./logs";
    const batchSize = Math.max(1, Number(argument("batch-size") ?? "25") || 25);
    const files = fs.readdirSync(dir).filter((f) => /^lottery_.+\.json$/.test(f)).sort();

    const rows: CoinReconciliation[] = [];
    for (const file of files) {
        let state: LotteryState;
        try {
            state = JSON.parse(fs.readFileSync(path.join(dir, file), "utf-8")) as LotteryState;
        } catch {
            console.error(`skipped ${file}: unreadable`);
            continue;
        }
        // Batch files are recorded with the path the buyer wrote them under;
        // read them from this folder whatever that path was.
        const loadBatch: BatchLoader = (p) => (p ? readBatchFile(path.join(dir, path.basename(p))) : null);
        const all = new Set<string>();
        for (const token of state.tokenBuys ?? []) {
            const signatures = coinSignatures(state, token.mint, loadBatch);
            for (const s of [...signatures.completed, ...signatures.earlier, ...signatures.deliveries, ...signatures.burns]) {
                all.add(s);
            }
        }
        const effects = await readAll([...all], keeper, batchSize);
        rows.push(...reconcileRound(state, loadBatch, effects));
    }

    const balances = await currentBalances(keeper);
    const byMint = new Map<string, bigint>();
    for (const row of rows) {
        byMint.set(row.mint, (byMint.get(row.mint) ?? 0n) + row.residual);
    }

    if (process.argv.includes("--json")) {
        console.log(JSON.stringify({
            rounds: rows.map((row) => ({ ...row, bought: String(row.bought), delivered: String(row.delivered), burned: String(row.burned), residual: String(row.residual), stranded: isStranded(row) })),
            coins: [...byMint.entries()].map(([mint, residual]) => ({ mint, residual: String(residual), keeperHolds: String(balances.get(mint) ?? 0n) })),
        }, null, 2));
        return;
    }

    console.log("round            coin      bought               delivered            burned               residual     note");
    for (const row of rows) {
        const incomplete = row.unreadPurchases > 0 || row.unreadTransfers > 0;
        const note = [
            isStranded(row) ? "STRANDED" : "",
            incomplete ? "INCOMPLETE" : "",
            row.unreadPurchases ? `${row.unreadPurchases} purchase(s) unread` : "",
            row.unreadTransfers ? `${row.unreadTransfers} transfer(s) unread` : "",
        ].filter(Boolean).join(", ");
        console.log(
            `${row.lotteryId.padEnd(16)} ${row.mint.slice(0, 8)}  ${String(row.bought).padStart(20)} ${String(row.delivered).padStart(20)} ${String(row.burned).padStart(20)} ${String(row.residual).padStart(12)}  ${note}`
        );
    }
    console.log("\ncoin      residual, all rounds   keeper holds now");
    for (const [mint, residual] of byMint) {
        console.log(`${mint.slice(0, 8)}  ${String(residual).padStart(20)}   ${String(balances.get(mint) ?? 0n).padStart(20)}`);
    }
}

if (require.main === module) {
    main().catch((error) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
    });
}
