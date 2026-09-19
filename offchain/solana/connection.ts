// src/solana/connection.ts
// Connecting to Solana

import { Connection, Keypair, Transaction, VersionedTransaction } from "@solana/web3.js";
import { AnchorProvider, Wallet } from "@coral-xyz/anchor";
import { RPC_ENDPOINT, SEND_TX_RATE_LIMIT } from "./config";
import { RateLimiter } from "./rateLimiter";

// =============================================================================
// CONNECTION
// =============================================================================

export const connection = new Connection(RPC_ENDPOINT, "confirmed");

// =============================================================================
// SEND RATE LIMIT
// =============================================================================

/**
 * The process-wide limiter on sending transactions. Every buying path
 * (pump.fun, PumpSwap, Jupiter) and token delivery go through it: the provider
 * has one ceiling for all of them.
 */
export const sendTxLimiter = new RateLimiter(SEND_TX_RATE_LIMIT);

// =============================================================================
// PROVIDER
// =============================================================================

/**
 * Creates an Anchor Provider for working with programs
 */
export function createProvider(wallet: Keypair): AnchorProvider {
    const anchorWallet: Wallet = {
        publicKey: wallet.publicKey,
        payer: wallet,
        signTransaction: async <T extends Transaction | VersionedTransaction>(tx: T): Promise<T> => {
            if (tx instanceof Transaction) {
                tx.sign(wallet);
            } else {
                tx.sign([wallet]);
            }
            return tx;
        },
        signAllTransactions: async <T extends Transaction | VersionedTransaction>(txs: T[]): Promise<T[]> => {
            txs.forEach((tx) => {
                if (tx instanceof Transaction) {
                    tx.sign(wallet);
                } else {
                    tx.sign([wallet]);
                }
            });
            return txs;
        },
    };

    return new AnchorProvider(connection, anchorWallet, {
        commitment: "confirmed",
    });
}
