// src/pumpfun/buy.ts
// Buying a token on pump.fun (bonding curve)

import {
    Keypair,
    PublicKey,
    Transaction,
    TransactionInstruction,
    SystemProgram,
    LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
    TOKEN_2022_PROGRAM_ID,
    createAssociatedTokenAccountIdempotentInstruction,
    getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { Program, BN } from "@coral-xyz/anchor";
import { connection, createProvider } from "../solana/connection";
import {
    PUMP_PROGRAM_ID,
    PUMP_FEE_PROGRAM_ID,
    getGlobalAddress,
    getBondingCurveAddress,
    getBondingCurveV2Address,
    getEventAuthorityAddress,
    pickBuybackFeeRecipient,
} from "../solana/config";
import { PUMPFUN_IDL } from "./idl";
import { extractPumpErrorName } from "./errors";
import { PostSendError, signTransaction } from "../solana/transaction";
import { budgetInstructions, COMPUTE_UNITS } from "../solana/priorityFee";
import { logger as rootLogger, Logger } from "../logger";

// =============================================================================
// POST-SEND ERROR
// =============================================================================

export { PostSendError } from "../solana/transaction";

// =============================================================================
// FEE RECIPIENT (from on-chain)
// =============================================================================

export interface PumpGlobal {
    feeRecipient: PublicKey;
    feeRecipients: PublicKey[];
    reservedFeeRecipient: PublicKey;
    reservedFeeRecipients: PublicKey[];
    buybackFeeRecipients: PublicKey[];
    mayhemModeEnabled: boolean;
}

let globalCache: PumpGlobal | null = null;

/**
 * How many bytes the parsed part of the Global account must occupy.
 *
 * The fields below add up to: 8 discriminator + 1 + 32 + 32 + 8*5 + 32 + 1
 * + 8*2 + 32*7 + 32*2 + 1 + 32 + 32 + 1 + 32*7 + 1 + 32*8 = 997.
 *
 * The check comes BEFORE reading, not after. A short buffer does not fail on
 * its own: `subarray` past the end returns an empty buffer and `new PublicKey`
 * of that is a valid all-zero address, so a truncated account would quietly
 * parse into zeros and we would send a transaction full of 1-address strings.
 *
 * The comparison is "less than" rather than "not equal": the account has a tail
 * (as of 2026-09-05 it is 1045 bytes, 48 more than the parsed part), and strict
 * equality would fail on perfectly good data.
 */
const PUMP_GLOBAL_PARSED_BYTES = 997;

/**
 * Parses the pump::Global account.
 *
 * The layout comes from the official IDL (pump-public-docs/idl/pump.json) and
 * the fields are in exactly this order. Reading `fee_recipient` alone is not
 * enough: both lists are needed, because which one applies is decided per coin
 * — see `allowedFeeRecipients`.
 *
 * The layout was cross-checked through account owners (2026-09-08): ordinary
 * recipients belong to the System Program, reserved ones to the Mayhem program
 * `MAyhSmzX…`, buyback to the fee program `pfeeUxB6…`. Owners matching the
 * meaning of the fields means the offsets have not drifted.
 */
export function parsePumpGlobal(data: Buffer): PumpGlobal {
    if (data.length < PUMP_GLOBAL_PARSED_BYTES) {
        throw new Error(
            `Pump Global account too small: ${data.length} bytes, need at least ${PUMP_GLOBAL_PARSED_BYTES}`
        );
    }

    let offset = 8; // discriminator
    const pubkey = (): PublicKey => {
        const value = new PublicKey(data.subarray(offset, offset + 32));
        offset += 32;
        return value;
    };
    const skip = (n: number): void => {
        offset += n;
    };
    const list = (n: number): PublicKey[] =>
        Array.from({ length: n }, () => pubkey());

    skip(1); // initialized
    skip(32); // authority
    const feeRecipient = pubkey();
    skip(8 * 5); // initial reserves (4) + fee_basis_points
    skip(32); // withdraw_authority
    skip(1); // enable_migrate
    skip(8 * 2); // pool_migration_fee + creator_fee_basis_points
    const feeRecipients = list(7);
    skip(32 * 2); // set_creator_authority + admin_set_creator_authority
    skip(1); // create_v2_enabled
    skip(32); // whitelist_pda
    const reservedFeeRecipient = pubkey();
    const mayhemModeEnabled = data[offset] !== 0;
    skip(1);
    const reservedFeeRecipients = list(7);
    skip(1); // is_cashback_enabled
    const buybackFeeRecipients = list(8);

    // Canary: if the layout was edited and the constant above was forgotten,
    // we find out immediately.
    if (offset !== PUMP_GLOBAL_PARSED_BYTES) {
        throw new Error(
            `Pump Global layout drift: parsed ${offset} bytes, expected ${PUMP_GLOBAL_PARSED_BYTES}`
        );
    }

    return {
        feeRecipient,
        feeRecipients,
        reservedFeeRecipient,
        reservedFeeRecipients,
        buybackFeeRecipients,
        mayhemModeEnabled,
    };
}

/**
 * Which fee recipients the program accepts for a PARTICULAR coin.
 *
 * The list is chosen by the `is_mayhem_mode` flag on the bonding curve itself,
 * not by the global `mayhem_mode_enabled`. The global flag only enables the
 * mode as a possibility; whether an individual coin takes part in it is a
 * property of that coin.
 *
 * The measurement on 2026-08-29 tied the list to the global flag and was wrong:
 * the coin it happened to use was in the mode, and the coincidence was taken
 * for a rule. Re-checked by simulation on mainnet on 2026-09-08 both ways, with
 * `mayhem_mode_enabled = true`:
 *
 *   coin with is_mayhem_mode = 1: ordinary list -> NotAuthorized, reserved -> ok
 *   coin with is_mayhem_mode = 0: ordinary list -> ok, reserved -> NotAuthorized
 *
 * So picking by the global flag broke EVERY purchase of an ordinary coin, which
 * is the main path. Reserved addresses belong to the `MAyhSmzX…` program (the
 * Mayhem accounts), ordinary ones to the System Program; the account owner
 * shows it and confirms the split.
 */
export function allowedFeeRecipients(
    global: PumpGlobal,
    isMayhemMode: boolean
): PublicKey[] {
    if (isMayhemMode) {
        return [global.reservedFeeRecipient, ...global.reservedFeeRecipients];
    }
    return [global.feeRecipient, ...global.feeRecipients];
}

function pickRandom<T>(items: T[]): T {
    return items[Math.floor(Math.random() * items.length)];
}

// =============================================================================
// QUOTE MINT (Custom Pairs)
// =============================================================================

/**
 * The offset of the `quote_mint` field in the bonding curve account.
 *
 * The layout before it: 8 discriminator + 5*8 reserves + 1 `complete`
 * + 32 `creator` + 1 `is_mayhem_mode` + 1 (a field whose purpose we do not
 * know) = 83. Our IDL only describes the account up to `is_mayhem_mode`, so
 * beyond that we read raw bytes rather than going through anchor.
 */
const BONDING_CURVE_QUOTE_MINT_OFFSET = 83;

/**
 * The curve asset for native SOL. pump.fun writes the System Program here
 * (32 zero bytes), not WSOL — checked against the `quote_mint` field of their API.
 */
const NATIVE_SOL_QUOTE = SystemProgram.programId;

/**
 * Reads the asset the curve is quoted in.
 *
 * On 2026-09-09 pump.fun opened "Custom Pairs": a curve can be created not only
 * in SOL but in USDC, WBTC or a tokenized stock. For those coins the
 * `buy_exact_sol_in` instruction answers `UnsupportedQuoteMint` (6063), so they
 * cannot be bought for SOL directly and need the aggregator.
 *
 * An account shorter than the field means the old layout, from before Custom
 * Pairs, where the curve can only be in SOL. We return the System Program
 * rather than throwing: that is exactly the behaviour from before the mode
 * existed. Checked against live coins — 2024 curves (150 bytes) honestly carry
 * the System Program here, so in practice this fallback never fires.
 */
export function readQuoteMint(data: Buffer): PublicKey {
    const end = BONDING_CURVE_QUOTE_MINT_OFFSET + 32;
    if (data.length < end) {
        return NATIVE_SOL_QUOTE;
    }
    return new PublicKey(data.subarray(BONDING_CURVE_QUOTE_MINT_OFFSET, end));
}

/** Whether the coin can be bought for SOL straight off the curve. */
export function isNativeSolQuote(quoteMint: PublicKey): boolean {
    return quoteMint.equals(NATIVE_SOL_QUOTE);
}

/** How long the Global cache lives. */
const GLOBAL_CACHE_TTL_MS = 10 * 60 * 1000;

let globalCacheAt = 0;
let globalInFlight: Promise<PumpGlobal> | null = null;

/**
 * Reads Global with a 10 minute cache.
 *
 * Not "once per process": the fee recipient lists themselves are edited on
 * chain without a program upgrade, and so is the global mode flag. If one
 * flipped mid-round with an eternal cache, every purchase would fail with
 * NotAuthorized until the worker restarted.
 *
 * The request is deduplicated: up to 50 batches start at once when a round
 * begins, and without this they would fire fifty identical requests at a node
 * whose rate limit we are already close to.
 */
async function fetchPumpGlobal(): Promise<PumpGlobal> {
    if (globalCache && Date.now() - globalCacheAt < GLOBAL_CACHE_TTL_MS) {
        return globalCache;
    }
    if (globalInFlight) {
        return globalInFlight;
    }
    globalInFlight = (async () => {
        const acc = await connection.getAccountInfo(getGlobalAddress(), {
            commitment: "confirmed",
        });
        if (!acc) {
            throw new Error("Pump Global account not found");
        }
        globalCache = parsePumpGlobal(Buffer.from(acc.data));
        globalCacheAt = Date.now();
        return globalCache;
    })();
    try {
        return await globalInFlight;
    } finally {
        globalInFlight = null;
    }
}

// =============================================================================
// TYPES
// =============================================================================

export interface BondingCurveInfo {
    mint: PublicKey;
    bondingCurve: PublicKey;
    associatedBondingCurve: PublicKey;
    creator: PublicKey;
    tokenProgramId: PublicKey;
    isToken2022: boolean;
    virtualSolReserves: BN;
    virtualTokenReserves: BN;
    isGraduated: boolean;
    /** Whether the coin is in Mayhem mode, which decides the fee recipient list. */
    isMayhemMode: boolean;
    /** The asset the curve is quoted in. Native SOL is the System Program. */
    quoteMint: PublicKey;
    /** The curve is in native SOL, so our `buy_exact_sol_in` can buy it. */
    isNativeSolQuote: boolean;
}

export interface BuyParams {
    /** The whole amount of SOL we spend, fee included (the spendable_sol_in argument) */
    spendableLamports: BN;
    /** The lower bound on tokens received (the min_tokens_out argument) */
    minTokensOut: BN;
    /** The expected token amount, in human units */
    estimatedTokens: number;
}

// =============================================================================
// FETCH
// =============================================================================

/**
 * Reads a token's bonding curve state from the chain.
 *
 * Example: mint = "6tGwYs5E..." →
 *   { virtualSolReserves: 40 SOL, virtualTokenReserves: 800M, isGraduated: false }
 */
export async function fetchBondingCurveInfo(
    mint: PublicKey,
    buyer: Keypair
): Promise<BondingCurveInfo> {
    // Work out the token program
    const mintInfo = await connection.getAccountInfo(mint);
    if (!mintInfo) {
        throw new Error("Mint account not found");
    }
    const tokenProgramId = mintInfo.owner;
    const isToken2022 = tokenProgramId.equals(TOKEN_2022_PROGRAM_ID);

    // Derive the addresses
    const bondingCurve = getBondingCurveAddress(mint);
    const associatedBondingCurve = getAssociatedTokenAddressSync(
        mint,
        bondingCurve,
        true,
        tokenProgramId
    );

    // Read the bonding curve state.
    //
    // We take the account raw and decode it with the same decoder that sits
    // behind `program.account.bondingCurve.fetch()` — byte for byte the same
    // parse (verified) — but this keeps the original bytes, and `quote_mint`
    // lives in them while our IDL does not know about it. That gets the quote
    // without a second call to the node: a round makes up to a hundred
    // purchases per coin, so an extra call would show.
    const provider = createProvider(buyer);
    const program = new Program(PUMPFUN_IDL as any, PUMP_PROGRAM_ID, provider);
    const curveAccount = await connection.getAccountInfo(bondingCurve);
    if (!curveAccount) {
        throw new Error("Bonding curve account not found");
    }
    const curveData = Buffer.from(curveAccount.data);
    const quoteMint = readQuoteMint(curveData);
    const state = program.coder.accounts.decode("BondingCurve", curveData) as {
        virtualTokenReserves: BN;
        virtualSolReserves: BN;
        complete: boolean;
        creator: PublicKey;
        isMayhemMode: boolean;
    };

    return {
        mint,
        bondingCurve,
        associatedBondingCurve,
        creator: state.creator,
        tokenProgramId,
        isToken2022,
        virtualSolReserves: state.virtualSolReserves,
        virtualTokenReserves: state.virtualTokenReserves,
        isGraduated: state.complete,
        // The field sits right after creator (offset 81). The deployed program
        // has a longer account than our IDL, but the prefix matches, so anchor reads it.
        isMayhemMode: state.isMayhemMode === true,
        quoteMint,
        isNativeSolQuote: isNativeSolQuote(quoteMint),
    };
}

// =============================================================================
// CALCULATE
// =============================================================================

// Every pump.fun token has 6 decimals, that is fixed by the protocol
const TOKEN_DECIMALS = 6;

// The pump.fun fee ceiling. Since the move to buy_exact_sol_in it no longer
// takes part in working out what we spend: the program subtracts the fee
// itself, and its rate moves (measurements on mainnet on 2026-08-29 gave 0, 95
// and 125 bps, and from September 1st it became a step function of market cap).
// The constant is only kept to compute a conservative minimum token amount.
/**
 * The fallback fee ceiling, used when the config account could not be read.
 *
 * The value as of 2026-09-05 (see `fetchMaxPumpFeeBps`). Only a safety net:
 * normally the rate is read from the chain.
 */
const FALLBACK_MAX_PUMP_FEE_BPS = 125;

/**
 * The seed of the fee config account. The same one passed into the instruction.
 */
const FEE_CONFIG_SEED = Buffer.from([
    1, 86, 224, 246, 147, 102, 90, 207, 68, 219, 21, 104, 191, 23, 91, 170,
    81, 137, 203, 151, 245, 210, 255, 59, 101, 93, 43, 182, 253, 109, 24, 176,
]);

export function getFeeConfigAddress(): PublicKey {
    const [pda] = PublicKey.findProgramAddressSync(
        [Buffer.from("fee_config"), FEE_CONFIG_SEED],
        PUMP_FEE_PROGRAM_ID
    );
    return pda;
}

/**
 * The largest total fee rate in the `FeeConfig` account.
 *
 * Layout from `pump_amm.json`:
 *   8 discriminator, 1 bump, 32 admin,
 *   flat_fees: 3 x u64 (lp, protocol, creator),
 *   fee_tiers: u32 length, then (u128 threshold + 3 x u64 rates) each.
 *
 * We take the MAXIMUM across all tiers rather than the rate of our own tier.
 * That way no market cap calculation is needed (which would require the mint
 * supply), and the error falls on the safe side: an overstated fee makes the
 * minimum token bound more conservative, while an understated one would cause
 * 6042 rejections.
 *
 * Since 2026-09-01 the scheme is tiered by market cap, so a hardcoded constant
 * can diverge from reality at any moment: the tiers live in an account that an
 * admin edits, with no program upgrade.
 */
export function parseMaxFeeBps(data: Buffer): number {
    let offset = 8 + 1 + 32;
    const readFeesTotal = (): number => {
        const lp = Number(data.readBigUInt64LE(offset));
        const protocol = Number(data.readBigUInt64LE(offset + 8));
        const creator = Number(data.readBigUInt64LE(offset + 16));
        offset += 24;
        return lp + protocol + creator;
    };

    if (data.length < offset + 24 + 4) {
        throw new Error(`Pump FeeConfig account too small: ${data.length} bytes`);
    }
    let max = readFeesTotal(); // flat_fees
    const tiers = data.readUInt32LE(offset);
    offset += 4;
    for (let i = 0; i < tiers; i++) {
        if (offset + 16 + 24 > data.length) {
            throw new Error(
                `Pump FeeConfig truncated: tier ${i} of ${tiers} runs past ${data.length} bytes`
            );
        }
        offset += 16; // market_cap_lamports_threshold: u128
        max = Math.max(max, readFeesTotal());
    }
    return max;
}

const FEE_CONFIG_CACHE_TTL_MS = 10 * 60 * 1000;
/**
 * The rate and where it came from.
 *
 * The source is returned explicitly rather than reconstructed by comparing with
 * the fallback value: the chain currently returns exactly 125, which is exactly
 * the fallback number, so the comparison would always say "fallback". The log
 * would stop telling "read 125" from "could not read" precisely when that
 * matters, while digging into 6042 rejections.
 */
export interface FeeCeiling {
    bps: number;
    source: "on-chain" | "fallback";
}

let feeBpsCache: number | null = null;
let feeBpsCacheAt = 0;
let feeBpsInFlight: Promise<FeeCeiling> | null = null;

/**
 * The current fee ceiling. Cached for 10 minutes and deduplicated, same as
 * Global: up to 50 batches start at once when a round begins.
 *
 * If the account cannot be read we return the fallback instead of failing the
 * purchase: the rate is only needed for the minimum token bound, and the safety
 * net covers that.
 */
export async function fetchMaxPumpFeeBps(log?: Logger): Promise<FeeCeiling> {
    if (feeBpsCache !== null && Date.now() - feeBpsCacheAt < FEE_CONFIG_CACHE_TTL_MS) {
        return { bps: feeBpsCache, source: "on-chain" };
    }
    if (feeBpsInFlight) {
        return feeBpsInFlight;
    }
    feeBpsInFlight = (async () => {
        try {
            const acc = await connection.getAccountInfo(getFeeConfigAddress(), {
                commitment: "confirmed",
            });
            if (!acc) {
                throw new Error("Pump FeeConfig account not found");
            }
            const bps = parseMaxFeeBps(Buffer.from(acc.data));
            feeBpsCache = bps;
            feeBpsCacheAt = Date.now();
            return { bps, source: "on-chain" as const };
        } catch (error) {
            (log || rootLogger).warn({
                event: "pumpfun.fee_config_unavailable",
                error: error instanceof Error ? error.message : String(error),
                fallbackBps: FALLBACK_MAX_PUMP_FEE_BPS,
            }, "Could not read pump fee config, using fallback ceiling");
            return { bps: FALLBACK_MAX_PUMP_FEE_BPS, source: "fallback" as const };
        }
    })();
    try {
        return await feeBpsInFlight;
    } finally {
        feeBpsInFlight = null;
    }
}

/**
 * Works out how many tokens N SOL buys, by the AMM formula.
 *
 * `solAmount` is the WHOLE purchase budget: the pump.fun fee comes out of it
 * first and the tokens are bought with the rest. That way the debit matches
 * what the batch budgeted.
 *
 * Tokens used to be computed from the full amount. The `buy(amount, maxSolCost)`
 * instruction takes an AMOUNT OF TOKENS, not SOL, and charges the fee on top of
 * the curve price: asking for `y*dx/(x+dx)` tokens, we paid exactly `dx` on the
 * curve plus 1.25%, that is `dx * 1.0125` on a budget of `dx`. On a 111 SOL
 * round that is ~1.35 SOL of overspend, and `insufficient funds` is classified
 * as non-retryable, so the tail of the purchases would end up abandoned.
 *
 * Slippage is deliberately NOT subtracted from the budget: it is a ceiling on
 * execution, not a cost. It is only spent if the price moved up between the
 * calculation and execution; subtracting it always would systematically
 * underbuy by 3% in the normal case. Headroom for it belongs on the keeper
 * balance.
 *
 * @param info - the bonding curve state
 * @param solAmount - the whole purchase budget in SOL (fee included)
 * @param slippageBps - slippage in basis points (500 = 5%)
 */
export function calculateBuyParams(
    info: BondingCurveInfo,
    solAmount: number,
    slippageBps: number,
    maxFeeBps: number = FALLBACK_MAX_PUMP_FEE_BPS
): BuyParams {
    const spendableLamports = new BN(Math.floor(solAmount * LAMPORTS_PER_SOL));

    // The program subtracts the fee from the budget itself, we do not need to
    // know it. But the minimum token bound needs an upper limit on it, or at
    // the maximum fee the real output lands below our minimum and the trade
    // bounces. The rate comes from the fee config account (see
    // fetchMaxPumpFeeBps) rather than being hardcoded: since 2026-09-01 it is
    // tiered and an admin edits it with no program upgrade.
    const curveInWorstCase = spendableLamports
        .mul(new BN(10000))
        .div(new BN(10000 + maxFeeBps));

    // AMM: dy = y * dx / (x + dx)
    const expectedTokens = info.virtualTokenReserves
        .mul(curveInWorstCase)
        .div(info.virtualSolReserves.add(curveInWorstCase));

    // Here slippage is expressed as a minimum on tokens received rather than a
    // ceiling on spend: the spend is now fixed and equals the budget.
    const minTokensOut = expectedTokens
        .mul(new BN(10000 - Math.min(slippageBps, 10000)))
        .div(new BN(10000));

    const estimatedTokens =
        Number(expectedTokens.toString()) / Math.pow(10, TOKEN_DECIMALS);

    return { spendableLamports, minTokensOut, estimatedTokens };
}

// =============================================================================
// BUILD INSTRUCTIONS
// =============================================================================

/**
 * Builds the instruction that creates the buyer's ATA (their token account).
 * Idempotent: if the ATA already exists it does nothing.
 *
 * Example: buyer = "2grLFG...", mint = "6tGwYs..." →
 *   Instruction: create ATA "5PRTXk..." to hold the tokens
 */
export function buildCreateAtaIx(
    info: BondingCurveInfo,
    buyer: Keypair
): ReturnType<typeof createAssociatedTokenAccountIdempotentInstruction> {
    const buyerAta = getAssociatedTokenAddressSync(
        info.mint,
        buyer.publicKey,
        false,
        info.tokenProgramId
    );

    return createAssociatedTokenAccountIdempotentInstruction(
        buyer.publicKey,
        buyerAta,
        buyer.publicKey,
        info.mint,
        info.tokenProgramId
    );
}

/**
 * Builds the `buy_exact_sol_in` instruction: a purchase for a given amount of SOL.
 *
 * Why not `buy(amount, maxSolCost)`: that one takes an AMOUNT OF TOKENS and
 * charges the fee on top of the curve price. Staying inside a budget meant
 * guessing the fee rate, and the rate moves (measurements on mainnet gave 0, 95
 * and 125 bps), and from 2026-09-01 it became a step function of the coin's
 * market cap. Here we set the amount and the program subtracts the fee.
 *
 * There are 18 accounts, not the 16 in the public IDL: the deployed program
 * also requires `bondingCurveV2` and `buybackFeeRecipient`. Verified by
 * simulation on mainnet on 2026-08-29 — with 16 accounts it rejects with
 * BuybackFeeRecipientMismatch, with 18 the simulation passes cleanly.
 */
const BUY_EXACT_SOL_IN_DISCRIMINATOR = Buffer.from([
    56, 252, 116, 8, 158, 223, 205, 95,
]);

export async function buildBuyIx(
    info: BondingCurveInfo,
    params: BuyParams,
    buyer: Keypair
): Promise<TransactionInstruction> {
    const buyerAta = getAssociatedTokenAddressSync(
        info.mint,
        buyer.publicKey,
        false,
        info.tokenProgramId
    );

    const [creatorVault] = PublicKey.findProgramAddressSync(
        [Buffer.from("creator-vault"), info.creator.toBuffer()],
        PUMP_PROGRAM_ID
    );
    const [globalVolumeAccumulator] = PublicKey.findProgramAddressSync(
        [Buffer.from("global_volume_accumulator")],
        PUMP_PROGRAM_ID
    );
    const [userVolumeAccumulator] = PublicKey.findProgramAddressSync(
        [Buffer.from("user_volume_accumulator"), buyer.publicKey.toBuffer()],
        PUMP_PROGRAM_ID
    );
    // The second seed is a fixed 32-byte constant from the official IDL,
    // checked byte for byte. It is NOT the pump program address.
    const FEE_CONFIG_SEED = Buffer.from([
        1, 86, 224, 246, 147, 102, 90, 207, 68, 219, 21, 104, 191, 23, 91, 170,
        81, 137, 203, 151, 245, 210, 255, 59, 101, 93, 43, 182, 253, 109, 24, 176,
    ]);
    const [feeConfig] = PublicKey.findProgramAddressSync(
        [Buffer.from("fee_config"), FEE_CONFIG_SEED],
        PUMP_FEE_PROGRAM_ID
    );

    const global = await fetchPumpGlobal();
    const feeRecipient = pickRandom(allowedFeeRecipients(global, info.isMayhemMode));
    const buybackFeeRecipient = global.buybackFeeRecipients.length
        ? pickRandom(global.buybackFeeRecipients)
        : pickBuybackFeeRecipient();

    // track_volume: OptionBool { bool } -> one byte
    const data = Buffer.concat([
        BUY_EXACT_SOL_IN_DISCRIMINATOR,
        params.spendableLamports.toArrayLike(Buffer, "le", 8),
        params.minTokensOut.toArrayLike(Buffer, "le", 8),
        Buffer.from([0]),
    ]);

    const keys = [
        { pubkey: getGlobalAddress(), isSigner: false, isWritable: false },
        { pubkey: feeRecipient, isSigner: false, isWritable: true },
        { pubkey: info.mint, isSigner: false, isWritable: false },
        { pubkey: info.bondingCurve, isSigner: false, isWritable: true },
        { pubkey: info.associatedBondingCurve, isSigner: false, isWritable: true },
        { pubkey: buyerAta, isSigner: false, isWritable: true },
        { pubkey: buyer.publicKey, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: info.tokenProgramId, isSigner: false, isWritable: false },
        { pubkey: creatorVault, isSigner: false, isWritable: true },
        { pubkey: getEventAuthorityAddress(), isSigner: false, isWritable: false },
        { pubkey: PUMP_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: globalVolumeAccumulator, isSigner: false, isWritable: false },
        { pubkey: userVolumeAccumulator, isSigner: false, isWritable: true },
        { pubkey: feeConfig, isSigner: false, isWritable: false },
        { pubkey: PUMP_FEE_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: getBondingCurveV2Address(info.mint), isSigner: false, isWritable: false },
        { pubkey: buybackFeeRecipient, isSigner: false, isWritable: true },
    ];

    return new TransactionInstruction({ programId: PUMP_PROGRAM_ID, keys, data });
}

// =============================================================================
// BUILD TRANSACTION
// =============================================================================

/**
 * Builds the whole purchase transaction: fetch → calculate → build instructions.
 *
 * Example: mint = "6tGwYs...", solAmount = 0.001, slippageBps = 500 →
 *   Transaction: [createATA, buy(20000 tokens, max 0.00105 SOL)]
 *
 * @param mint - the token address
 * @param solAmount - how much SOL to spend
 * @param buyer - the buyer's keypair
 * @param slippageBps - slippage in basis points (500 = 5%)
 */
export async function buildPumpfunBuyTransaction(
    mint: PublicKey,
    solAmount: number,
    buyer: Keypair,
    slippageBps: number,
    log?: Logger
): Promise<Transaction> {
    const l = log || rootLogger;

    // 1. Read the bonding curve state
    const info = await fetchBondingCurveInfo(mint, buyer);

    // The curve is not in SOL ("Custom Pairs", since 2026-09-09): our
    // `buy_exact_sol_in` would get `UnsupportedQuoteMint` (6063) back from the
    // program. We refuse BEFORE building, so as not to waste the fee config
    // read, the blockhash, the signature and the simulation up to a hundred
    // times per coin. It is a pre-send error, so the router in buy.ts moves the
    // purchase to the aggregator, where such coins do trade.
    if (!info.isNativeSolQuote) {
        l.info({
            event: "pumpfun.non_sol_quote",
            mint: mint.toBase58(),
            quoteMint: info.quoteMint.toBase58(),
        }, "Bonding curve is quoted in a non-SOL asset, routing to the aggregator");
        throw new Error(
            `Token ${mint.toBase58()} has a non-SOL bonding curve ` +
            `(quote ${info.quoteMint.toBase58()}): buy_exact_sol_in is not applicable`
        );
    }

    // 2. Work out the purchase parameters.
    // The rate comes from the chain rather than a constant: since 2026-09-01 it
    // is tiered and an admin edits it with no program upgrade.
    const fee = await fetchMaxPumpFeeBps(l);
    const params = calculateBuyParams(info, solAmount, slippageBps, fee.bps);

    // 3. Logging
    const virtualSol = info.virtualSolReserves.toNumber() / LAMPORTS_PER_SOL;
    const virtualTokens = Number(info.virtualTokenReserves.toString()) / Math.pow(10, TOKEN_DECIMALS);
    const pricePerToken = virtualSol / virtualTokens;

    l.info({
        event: "pumpfun.build_info",
        mint: mint.toBase58(),
        pricePerToken,
        virtualSol,
        virtualTokens,
        estimatedTokens: params.estimatedTokens,
        spendableSol: params.spendableLamports.toNumber() / LAMPORTS_PER_SOL,
        minTokensOut: params.minTokensOut.toString(),
        // Which rate the lower bound was computed at, so the round logs show
        // what the program actually charged rather than what we assumed.
        maxFeeBps: fee.bps,
        feeSource: fee.source,
        tokenProgram: info.isToken2022 ? "Token-2022" : "Classic",
        creator: info.creator.toBase58().slice(0, 8),
        // Which list the fee recipient came from: this field explains in the
        // round logs why that address was picked and not another.
        isMayhemMode: info.isMayhemMode,
    }, "Pumpfun buy params calculated");

    if (info.isGraduated) {
        l.warn({ event: "pumpfun.graduation_detected", mint: mint.toBase58() },
            "Token has graduated");
        throw new Error(
            `Token ${mint.toBase58()} has graduated (bonding curve complete)`
        );
    }

    // 4. Build the instructions
    const createAtaIx = buildCreateAtaIx(info, buyer);
    const buyIx = await buildBuyIx(info, params, buyer);

    // 5. Paying for a place in the block. Priced from the accounts this
    //    transaction writes: the queue price lives at the curve, not "in the
    //    network at large". Without these instructions a purchase during a busy
    //    hour simply does not make it into a block.
    const budget = await budgetInstructions(
        "pumpfun",
        COMPUTE_UNITS.pumpfun,
        [info.bondingCurve, info.associatedBondingCurve, buyer.publicKey],
        solAmount
    );

    // 6. Assemble the transaction. Budget goes first, that is where the runtime reads it.
    return new Transaction().add(...budget).add(createAtaIx).add(buyIx);
}

// =============================================================================
// MAIN FUNCTION
// =============================================================================

/**
 * Buys a token on pump.fun (bonding curve).
 *
 * @param mint - the token address
 * @param solAmount - how much SOL to spend
 * @param keeper - the wallet keypair
 * @param slippageBps - slippage in basis points (500 = 5%)
 * @returns transaction signature
 */
export async function buyPumpfun(
    mint: PublicKey,
    solAmount: number,
    keeper: Keypair,
    slippageBps: number,
    log?: Logger
): Promise<string> {
    const l = log || rootLogger;

    // Stage 1 — pre-send: fetch + build (a fallback is safe here)
    const tx = await buildPumpfunBuyTransaction(mint, solAmount, keeper, slippageBps, l);

    // Stage 2 — pre-send: sign + simulate (a fallback is safe, the tx is not in the network yet)
    const signed = await signTransaction(tx, keeper);
    const simulation = await connection.simulateTransaction(signed);
    if (simulation.value.err) {
        const named = extractPumpErrorName(simulation.value.err);
        l.error({
            event: "pumpfun.simulation_failed",
            mint: mint.toBase58(),
            err: simulation.value.err,
            errorCode: named?.code,
            errorName: named?.name,
        }, "Simulation failed");
        const suffix = named?.name ? ` (${named.name})` : named ? ` (Custom ${named.code})` : "";
        throw new Error(
            `Simulation failed: ${JSON.stringify(simulation.value.err)}${suffix}`
        );
    }

    // Stage 3 — post-send: the tx goes out (no fallback allowed)
    let signature: string | undefined;
    try {
        signature = await connection.sendRawTransaction(signed.serialize(), {
            skipPreflight: true,
        });

        // We wait on the blockhash the transaction was signed with. A fresh one
        // taken after sending would give a deadline about 150 slots longer than
        // the real one, and an expired transaction would sit in the wait longer
        // than it should — with a time-limited retry window that is attempts
        // thrown away.
        const confirmation = await connection.confirmTransaction(
            { signature, ...signed.context },
            "confirmed"
        );

        if (confirmation.value.err) {
            l.error({ event: "pumpfun.on_chain_failure", mint: mint.toBase58(), signature, err: confirmation.value.err },
                "Transaction failed on-chain");
            throw new Error(
                `Transaction failed on-chain: ${JSON.stringify(confirmation.value.err)}`
            );
        }

        return signature;
    } catch (error) {
        if (error instanceof PostSendError) throw error;
        const msg = error instanceof Error ? error.message : String(error);
        l.error({ event: "pumpfun.send_failed", mint: mint.toBase58(), signature, error: msg },
            "Transaction send/confirm failed");
        throw new PostSendError(`Transaction send/confirm failed: ${msg}`, signature, error);
    }
}
