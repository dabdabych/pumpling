// src/pumpswap/buy.ts
// Buying a token straight from a PumpSwap pool (pAMMBay6…)
//
// The fallback for graduated pump.fun tokens that trade on their own PumpSwap
// pool but are excluded from Jupiter routing (TOKEN_NOT_TRADABLE). See the
// router in buy.ts and offchain/CLAUDE.md.
//
// We use the official @pump-fun/pump-swap-sdk: it keeps up with the fee
// program's account set (pump does ship breaking fee upgrades), so we do not
// assemble the instruction by hand.

import { Keypair, PublicKey, Transaction, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import {
    OnlinePumpAmmSdk,
    PumpAmmSdk,
    canonicalPumpPoolPda,
} from "@pump-fun/pump-swap-sdk";
import { connection, sendTxLimiter } from "../solana/connection";
import { getSignedTransactionSignature, PostSendError } from "../solana/transaction";
import { budgetInstructions, COMPUTE_UNITS, hasBudgetInstruction } from "../solana/priorityFee";
import { logger as rootLogger, Logger } from "../logger";

const onlineSdk = new OnlinePumpAmmSdk(connection);
const offlineSdk = new PumpAmmSdk();

/**
 * Buys a token directly in the canonical PumpSwap pool (quote = WSOL).
 *
 * @param mint - the token address (base mint)
 * @param solAmount - how much SOL to spend
 * @param keeper - the buyer's keypair
 * @param slippageBps - slippage in basis points (500 = 5%)
 * @returns transaction signature
 */
export async function buyPumpswap(
    mint: PublicKey,
    solAmount: number,
    keeper: Keypair,
    slippageBps: number,
    log?: Logger
): Promise<string> {
    const l = log || rootLogger;
    const lamports = Math.floor(solAmount * LAMPORTS_PER_SOL);

    if (!Number.isFinite(lamports) || lamports <= 0) {
        throw new Error(`Invalid solAmount: ${solAmount}`);
    }

    // 1. The canonical pool for the mint (quote = WSOL by default). Throws if there is none.
    const pool = canonicalPumpPoolPda(mint);

    // 2. Read the pool state, reserves and accounts (including the wSOL wrapper).
    const swapState = await onlineSdk.swapSolanaState(pool, keeper.publicKey);

    // 3. Build the instructions: spend exactly `lamports` of quote (SOL), get base by the AMM.
    //    The SDK takes slippage in percent (0-100), we have bps → divide by 100.
    const ixs = await offlineSdk.buyQuoteInput(swapState, new BN(lamports), slippageBps / 100);

    l.info({
        event: "pumpswap.build_info",
        mint: mint.toBase58(),
        pool: pool.toBase58(),
        solAmount,
        slippageBps,
        instructions: ixs.length,
    }, "PumpSwap buy instructions built");

    // 4. Paying for queue position. The SDK sometimes adds budget instructions
    //    itself, and the network rejects duplicates outright, so we only add what is missing.
    const budget = await budgetInstructions(
        "pumpswap",
        COMPUTE_UNITS.pumpswap,
        [pool, keeper.publicKey],
        solAmount
    );
    const missing = budget.filter((instruction) =>
        !hasBudgetInstruction(ixs, instruction.data[0] === 2 ? "limit" : "price")
    );

    // 5. Assemble, sign, send. buyQuoteInput already includes the ATA creation and the wSOL wrap/unwrap.
    const tx = new Transaction().add(...missing).add(...ixs);
    // We take our place in the send queue before signing, or the blockhash goes stale while waiting.
    await sendTxLimiter.acquire();
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.feePayer = keeper.publicKey;
    tx.sign(keeper);

    const simulation = await connection.simulateTransaction(tx);
    if (simulation.value.err) {
        l.error({ event: "pumpswap.simulation_failed", mint: mint.toBase58(), pool: pool.toBase58(), err: simulation.value.err },
            "PumpSwap transaction simulation failed");
        throw new Error(
            `PumpSwap simulation failed: ${JSON.stringify(simulation.value.err)}`
        );
    }

    const signature = getSignedTransactionSignature(tx);
    try {
        const sentSignature = await connection.sendRawTransaction(tx.serialize(), {
            skipPreflight: true,
            maxRetries: 3,
        });

        const confirmation = await connection.confirmTransaction(
            { signature: sentSignature, blockhash, lastValidBlockHeight },
            "confirmed"
        );

        if (confirmation.value.err) {
            l.error({ event: "pumpswap.on_chain_failure", mint: mint.toBase58(), signature: sentSignature, err: confirmation.value.err },
                "PumpSwap transaction failed on-chain");
            throw new Error(
                `Transaction confirmed but failed on-chain: ${JSON.stringify(confirmation.value.err)}`
            );
        }

        l.info({ event: "pumpswap.completed", mint: mint.toBase58(), signature: sentSignature.slice(0, 16) },
            "PumpSwap buy completed");
        return sentSignature;
    } catch (error) {
        if (error instanceof PostSendError) throw error;
        const msg = error instanceof Error ? error.message : String(error);
        l.error({ event: "pumpswap.send_failed", mint: mint.toBase58(), pool: pool.toBase58(), signature, error: msg },
            "PumpSwap transaction send/confirm failed");
        throw new PostSendError(`PumpSwap transaction send/confirm failed: ${msg}`, signature, error);
    }
}
