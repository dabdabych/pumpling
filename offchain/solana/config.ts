// src/solana/config.ts
// Configuration: program addresses, PDAs, network

import { PublicKey } from "@solana/web3.js";

// =============================================================================
// PUMP.FUN CONSTANTS
// =============================================================================

export const PUMP_PROGRAM_ID = new PublicKey(
    "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"
);

// =============================================================================
// PUMP.FUN PDA DERIVATIONS
// =============================================================================

/** The pump.fun Global PDA */
export function getGlobalAddress(): PublicKey {
    const [pda] = PublicKey.findProgramAddressSync(
        [Buffer.from("global")],
        PUMP_PROGRAM_ID
    );
    return pda;
}

/** The bonding curve PDA for a token. Example: mint = "6tGwYs..." → "7kBq..." */
export function getBondingCurveAddress(mint: PublicKey): PublicKey {
    const [pda] = PublicKey.findProgramAddressSync(
        [Buffer.from("bonding-curve"), mint.toBuffer()],
        PUMP_PROGRAM_ID
    );
    return pda;
}

/** The pump.fun Bonding Curve V2 PDA (the cashback upgrade, Feb 2026) */
export function getBondingCurveV2Address(mint: PublicKey): PublicKey {
    const [pda] = PublicKey.findProgramAddressSync(
        [Buffer.from("bonding-curve-v2"), mint.toBuffer()],
        PUMP_PROGRAM_ID
    );
    return pda;
}

// 8 buyback fee recipients (breaking program upgrade 2026-04-28).
// Buy/sell ix must include exactly one of these as the 18th account.
// Source: https://github.com/pump-fun/pump-public-docs/blob/main/docs/BREAKING_FEE_RECIPIENT.md
export const PUMP_BUYBACK_FEE_RECIPIENTS: PublicKey[] = [
    new PublicKey("5YxQFdt3Tr9zJLvkFccqXVUwhdTWJQc1fFg2YPbxvxeD"),
    new PublicKey("9M4giFFMxmFGXtc3feFzRai56WbBqehoSeRE5GK7gf7"),
    new PublicKey("GXPFM2caqTtQYC2cJ5yJRi9VDkpsYZXzYdwYpGnLmtDL"),
    new PublicKey("3BpXnfJaUTiwXnJNe7Ej1rcbzqTTQUvLShZaWazebsVR"),
    new PublicKey("5cjcW9wExnJJiqgLjq7DEG75Pm6JBgE1hNv4B2vHXUW6"),
    new PublicKey("EHAAiTxcdDwQ3U4bU6YcMsQGaekdzLS3B5SmYo46kJtL"),
    new PublicKey("5eHhjP8JaYkz83CWwvGU2uMUXefd3AazWGx4gpcuEEYD"),
    new PublicKey("A7hAgCzFw14fejgCp387JUJRMNyz4j89JKnhtKU8piqW"),
];

/** Pick a random buyback fee recipient — spreads load across the 8 recipients. */
export function pickBuybackFeeRecipient(): PublicKey {
    const idx = Math.floor(Math.random() * PUMP_BUYBACK_FEE_RECIPIENTS.length);
    return PUMP_BUYBACK_FEE_RECIPIENTS[idx];
}

/** The pump.fun Event Authority PDA */
export function getEventAuthorityAddress(): PublicKey {
    const [pda] = PublicKey.findProgramAddressSync(
        [Buffer.from("__event_authority")],
        PUMP_PROGRAM_ID
    );
    return pda;
}

// fee_recipient is read from the on-chain Global account
// see src/pumpfun/buy.ts → fetchFeeRecipient()

// =============================================================================
// PUMP FEE PROGRAM
// =============================================================================

export const PUMP_FEE_PROGRAM_ID = new PublicKey(
    "pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ"
);

// =============================================================================
// PUMPSWAP CONSTANTS
// =============================================================================

// PumpSwap AMM is where graduated pump.fun tokens trade. The buy/sell account
// set (including the fee program) is assembled by @pump-fun/pump-swap-sdk, see
// pumpswap/buy.ts.
export const PUMPSWAP_PROGRAM_ID = new PublicKey(
    "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA"
);

// =============================================================================
// JUPITER (DEX AGGREGATOR)
// =============================================================================

// Jupiter lite-api: the public endpoint, no auth
// api.jup.ag needs an API key, lite-api.jup.ag does not
export const JUPITER_BASE_URL = process.env.JUPITER_BASE_URL || "https://lite-api.jup.ag";
export const JUPITER_QUOTE_URL = `${JUPITER_BASE_URL}/swap/v1/quote`;
export const JUPITER_SWAP_URL = `${JUPITER_BASE_URL}/swap/v1/swap`;

/** Slippage in basis points (300 = 3%) */
export const SLIPPAGE_BPS = parseInt(process.env.SLIPPAGE_BPS || "300", 10);

/** The prioritization fee in lamports */
export const PRIORITIZATION_FEE_LAMPORTS = parseInt(
    process.env.PRIORITIZATION_FEE_LAMPORTS || "5000",
    10
);

/** The maximum number of accounts in a Jupiter transaction */
export const JUPITER_MAX_ACCOUNTS = parseInt(
    process.env.JUPITER_MAX_ACCOUNTS || "64",
    10
);

/** Direct routes only (no intermediate tokens) */
export const JUPITER_ONLY_DIRECT_ROUTES =
    process.env.JUPITER_ONLY_DIRECT_ROUTES === "1";

// =============================================================================
// NETWORK
// =============================================================================

const NETWORK = process.env.NETWORK || "mainnet";
const RPC_DEVNET = process.env.RPC_DEVNET || "https://api.devnet.solana.com";
const RPC_MAINNET = process.env.RPC_MAINNET || "https://api.mainnet-beta.solana.com";

export const RPC_ENDPOINT = NETWORK === "devnet" ? RPC_DEVNET : RPC_MAINNET;

// =============================================================================
// RATE LIMIT
// =============================================================================

/**
 * How many transactions a second we send to the network.
 *
 * Four by default: a little under the Helius Developer ceiling (five a second).
 * On a bigger plan it goes up through an environment variable, with no code
 * change needed.
 */
export const SEND_TX_RATE_LIMIT = (() => {
    const parsed = Number(process.env.SEND_TX_RATE_LIMIT || "4");
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 4;
})();
