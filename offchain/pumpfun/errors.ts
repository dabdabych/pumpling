// Maps pump.fun program error codes to names so simulation/transaction
// failures log "BuySlippageBelowMinTokensOut" instead of "Custom 6042".
// Source: https://github.com/pump-fun/pump-public-docs/blob/main/idl/pump.json
//
// The table is generated from the official IDL in full (72 codes, 6000..6071)
// rather than topped up by hand. There used to be 27 codes here, and one of the
// missing ones was 6042 — the very code buy_exact_sol_in uses to reject a trade
// on slippage. Without it isSlippageError never fired, and the slippage ladder
// in the main loop never started at all.

export const PUMP_ERROR_NAMES: Record<number, string> = {
    6000: "NotAuthorized",
    6001: "AlreadyInitialized",
    6002: "TooMuchSolRequired",
    6003: "TooLittleSolReceived",
    6004: "MintDoesNotMatchBondingCurve",
    6005: "BondingCurveComplete",
    6006: "BondingCurveNotComplete",
    6007: "NotInitialized",
    6008: "WithdrawTooFrequent",
    6009: "NewSizeShouldBeGreaterThanCurrentSize",
    6010: "AccountTypeNotSupported",
    6011: "InitialRealTokenReservesShouldBeLessThanTokenTotalSupply",
    6012: "InitialVirtualTokenReservesShouldBeGreaterThanInitialRealTokenReserves",
    6013: "FeeBasisPointsGreaterThanMaximum",
    6014: "AllZerosWithdrawAuthority",
    6015: "PoolMigrationFeeShouldBeLessThanFinalRealSolReserves",
    6016: "PoolMigrationFeeShouldBeGreaterThanCreatorFeePlusMaxMigrateFees",
    6017: "DisabledWithdraw",
    6018: "DisabledMigrate",
    6019: "InvalidCreator",
    6020: "BuyZeroAmount",
    6021: "NotEnoughTokensToBuy",
    6022: "SellZeroAmount",
    6023: "NotEnoughTokensToSell",
    6024: "Overflow",
    6025: "Truncation",
    6026: "DivisionByZero",
    6027: "NotEnoughRemainingAccounts",
    6028: "AllFeeRecipientsShouldBeNonZero",
    6029: "UnsortedNotUniqueFeeRecipients",
    6030: "CreatorShouldNotBeZero",
    6031: "StartTimeInThePast",
    6032: "EndTimeInThePast",
    6033: "EndTimeBeforeStartTime",
    6034: "TimeRangeTooLarge",
    6035: "EndTimeBeforeCurrentDay",
    6036: "SupplyUpdateForFinishedRange",
    6037: "DayIndexAfterEndIndex",
    6038: "DayInActiveRange",
    6039: "InvalidIncentiveMint",
    6040: "BuyNotEnoughSolToCoverRent",
    6041: "BuyNotEnoughSolToCoverFees",
    6042: "BuySlippageBelowMinTokensOut",
    6043: "NameTooLong",
    6044: "SymbolTooLong",
    6045: "UriTooLong",
    6046: "CreateV2Disabled",
    6047: "CpitializeMayhemFailed",
    6048: "MayhemModeDisabled",
    6049: "CreatorMigratedToSharingConfig",
    6050: "UnableToDistributeCreatorVaultMigratedToSharingConfig",
    6051: "SharingConfigNotActive",
    6052: "UnableToDistributeCreatorFeesToExecutableRecipient",
    6053: "BondingCurveAndSharingConfigCreatorMismatch",
    6054: "ShareholdersAndRemainingAccountsMismatch",
    6055: "InvalidShareBps",
    6056: "CashbackNotEnabled",
    6057: "BuybackFeeRecipientNotAuthorized",
    6058: "AllBuybackFeeRecipientsShouldBeNonZero",
    6059: "NotUniqueBuybackFeeRecipients",
    6060: "BuybackBasisPointsOutOfRange",
    6061: "WrongBuybackFeeRecipientsCount",
    6062: "BuybackFeeRecipientMissing",
    6063: "UnsupportedQuoteMint",
    6064: "InvalidQuoteTokenProgram",
    6065: "InvalidAssociatedQuoteBondingCurve",
    6066: "QuoteMintWhitelistFull",
    6067: "QuoteMintAlreadyWhitelisted",
    6068: "QuoteMintNotWhitelisted",
    6069: "QuoteMintNotEligibleForWhitelist",
    6070: "UnableToDistributeCreatorFeesToUninitializedAccount",
    6071: "MayhemModeQuoteMintNotAllowed",
};

/** Extract `{"Custom": N}` from a Solana TransactionError and look up name. */
export function extractPumpErrorName(err: unknown): { code: number; name: string | null } | null {
    if (!err || typeof err !== "object") return null;
    const ie = (err as Record<string, unknown>).InstructionError;
    if (!Array.isArray(ie) || ie.length < 2) return null;
    const inner = ie[1];
    if (!inner || typeof inner !== "object") return null;
    const custom = (inner as Record<string, unknown>).Custom;
    if (typeof custom !== "number") return null;
    return { code: custom, name: PUMP_ERROR_NAMES[custom] ?? null };
}

/**
 * Pulls the program error number out of a message that has already been
 * turned into a string.
 *
 * The number does not name the program by itself: the same numbers mean
 * different things on pump.fun and on the aggregator. Matching it against a
 * table is the caller's job, since they know where they went.
 *
 * The same error reaches us in three different shapes, and only the first used
 * to be recognised:
 *   1. our own explicit simulation — `... {"InstructionError":[0,{"Custom":6042}]} (Name)`
 *   2. preflight when sending       — `... custom program error: 0x179a`
 *   3. arrived and failed           — `... {"InstructionError":[0,{"Custom":6042}]}`
 *
 * The third shape is classic slippage: the simulation passed, the price moved,
 * the transaction failed on chain. While only the first form was parsed, such a
 * rejection looked like an unknown error and the tolerance ladder never fired
 * for it.
 */
export function extractCustomErrorCode(message: string): number | null {
    const json = message.match(/"Custom"\s*:\s*(\d+)/);
    if (json) {
        return Number(json[1]);
    }
    const hex = message.match(/custom program error:\s*0x([0-9a-fA-F]+)/);
    if (hex) {
        return parseInt(hex[1], 16);
    }
    return null;
}

/**
 * Codes meaning "the price moved, the amount condition was not met".
 * These are worth repeating with a wider tolerance.
 *
 * `TooMuchSolRequired` comes from the old `buy` instruction and is kept in case
 * of old records in the state. `BuySlippageBelowMinTokensOut` comes from the
 * current `buy_exact_sol_in`. `TooLittleSolReceived` is the mirror code for selling.
 */
export const PUMP_SLIPPAGE_CODES: ReadonlySet<number> = new Set([6002, 6003, 6042]);
