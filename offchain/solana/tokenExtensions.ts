// solana/tokenExtensions.ts
// Parsing Token-2022 extensions and judging whether we can deliver what we buy.

import { Connection, PublicKey } from "@solana/web3.js";
import {
    TOKEN_2022_PROGRAM_ID,
    AccountState,
    getMint,
    getExtensionTypes,
    getTransferFeeConfig,
    getTransferHook,
    getDefaultAccountState,
    getPermanentDelegate,
    TransferFeeConfig,
} from "@solana/spl-token";
import { connection as defaultConnection } from "./connection";
import { logger as rootLogger, Logger } from "../logger";

/**
 * Extension numbers from the token-2022 program source
 * (interface/src/extension/mod.rs). The `@solana/spl-token@0.3.11` library only
 * knows 0..19, so we keep our own table: without it, extensions newer than
 * `TokenMetadata` would all look like the same nameless numbers.
 */
export const EXTENSION_NAMES: Record<number, string> = {
    0: "Uninitialized",
    1: "TransferFeeConfig",
    2: "TransferFeeAmount",
    3: "MintCloseAuthority",
    4: "ConfidentialTransferMint",
    5: "ConfidentialTransferAccount",
    6: "DefaultAccountState",
    7: "ImmutableOwner",
    8: "MemoTransfer",
    9: "NonTransferable",
    10: "InterestBearingConfig",
    11: "CpiGuard",
    12: "PermanentDelegate",
    13: "NonTransferableAccount",
    14: "TransferHook",
    15: "TransferHookAccount",
    16: "ConfidentialTransferFeeConfig",
    17: "ConfidentialTransferFeeAmount",
    18: "MetadataPointer",
    19: "TokenMetadata",
    20: "GroupPointer",
    21: "TokenGroup",
    22: "GroupMemberPointer",
    23: "TokenGroupMember",
    24: "ConfidentialMintBurn",
    25: "ScaledUiAmount",
    26: "Pausable",
    27: "PausableAccount",
    28: "PermissionedBurn",
};

export interface MintExtensionReport {
    mint: string;
    programId: PublicKey;
    decimals: number;
    isToken2022: boolean;
    /** The mint's extension numbers, as they sit in the account. */
    extensions: number[];
    /**
     * Why delivery will not work. An empty list means the delivery path is
     * fine (possibly with the caveats in `warnings`).
     */
    blockers: string[];
    /** Does not block delivery, but affects it or how much the coin can be trusted. */
    warnings: string[];
    /** The transfer fee, if there is one: the recipient gets less. */
    transferFeeConfig: TransferFeeConfig | null;
    /** The transfer instruction needs extra accounts. */
    hasTransferHook: boolean;
}

/**
 * Extensions that make delivery impossible.
 *
 * `NonTransferable` — transfers are forbidden by the program, so whatever we
 * bought would stay on the keeper forever.
 *
 * `DefaultAccountState` is not dangerous in itself, only when the default state
 * is Frozen: then the recipient's account is created frozen, and only the
 * mint's freeze authority can thaw it. So we check its value, not whether the
 * extension is present.
 */
const EXT_NON_TRANSFERABLE = 9;
const EXT_DEFAULT_ACCOUNT_STATE = 6;
const EXT_TRANSFER_FEE_CONFIG = 1;
const EXT_TRANSFER_HOOK = 14;
const EXT_PERMANENT_DELEGATE = 12;
const EXT_PAUSABLE = 26;

/**
 * Extensions that make no difference to delivery: metadata, groups and the way
 * an amount is DISPLAYED. Listed explicitly, so that anything unfamiliar ends up
 * in the warnings instead of passing in silence.
 */
const HARMLESS_EXTENSIONS = new Set([
    3,  // MintCloseAuthority
    7,  // ImmutableOwner
    10, // InterestBearingConfig — changes the display, not balances
    18, 19, 20, 21, 22, 23, // metadata and groups
    25, // ScaledUiAmount — also about display
]);

const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = new Map<string, { at: number; report: MintExtensionReport }>();

/**
 * Reads the mint and says what delivery has in store.
 *
 * Called once per coin before buying: buying something that cannot be delivered
 * afterwards means trading refundable SOL for an unrefundable token.
 */
export async function inspectMint(
    mint: PublicKey,
    log?: Logger,
    conn: Connection = defaultConnection
): Promise<MintExtensionReport> {
    const key = mint.toBase58();
    const cached = cache.get(key);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
        return cached.report;
    }

    const account = await conn.getAccountInfo(mint, { commitment: "confirmed" });
    if (!account) {
        throw new Error(`Mint account not found: ${key}`);
    }
    const programId = account.owner;
    const isToken2022 = programId.equals(TOKEN_2022_PROGRAM_ID);
    const mintInfo = await getMint(conn, mint, "confirmed", programId);

    const report: MintExtensionReport = {
        mint: key,
        programId,
        decimals: mintInfo.decimals,
        isToken2022,
        extensions: [],
        blockers: [],
        warnings: [],
        transferFeeConfig: null,
        hasTransferHook: false,
    };

    if (!isToken2022) {
        cache.set(key, { at: Date.now(), report });
        return report;
    }

    report.extensions = mintInfo.tlvData.length
        ? (getExtensionTypes(mintInfo.tlvData) as unknown as number[])
        : [];

    for (const ext of report.extensions) {
        const name = EXTENSION_NAMES[ext] ?? `Unknown(${ext})`;

        if (ext === EXT_NON_TRANSFERABLE) {
            report.blockers.push(`${name}: transfers are forbidden by the program`);
        } else if (ext === EXT_DEFAULT_ACCOUNT_STATE) {
            const state = getDefaultAccountState(mintInfo);
            if (state?.state === AccountState.Frozen) {
                report.blockers.push(
                    `${name}: the recipient account is created frozen, and only the freeze authority can thaw it`
                );
            } else {
                report.warnings.push(`${name}: the default state is not Frozen`);
            }
        } else if (ext === EXT_TRANSFER_FEE_CONFIG) {
            report.transferFeeConfig = getTransferFeeConfig(mintInfo);
            const bps = report.transferFeeConfig?.newerTransferFee.transferFeeBasisPoints;
            report.warnings.push(
                `${name}: the recipient receives less than was sent (${bps ?? "?"} bps)`
            );
        } else if (ext === EXT_TRANSFER_HOOK) {
            const hook = getTransferHook(mintInfo);
            // A hook with no program does nothing: the extension is there but
            // the transfer is ordinary. We only count it as a hook when a
            // program is set.
            const hookProgram = hook?.programId;
            report.hasTransferHook =
                !!hookProgram && !hookProgram.equals(PublicKey.default);
            if (report.hasTransferHook) {
                report.warnings.push(
                    `${name}: the transfer needs extra accounts (${hookProgram!.toBase58().slice(0, 8)}…), and the hook may refuse`
                );
            }
        } else if (ext === EXT_PERMANENT_DELEGATE) {
            const delegate = getPermanentDelegate(mintInfo);
            report.warnings.push(
                `${name}: ${delegate?.delegate.toBase58().slice(0, 8) ?? "?"}… can take tokens from any holder`
            );
        } else if (ext === EXT_PAUSABLE) {
            // We do not block delivery: transfers are allowed at the time of
            // the check, and a pause can be put on later anyway. The risk is of
            // the same kind as a freeze authority on an ordinary SPL token, and
            // that always exists.
            report.warnings.push(`${name}: transfers can be paused`);
        } else if (!HARMLESS_EXTENSIONS.has(ext)) {
            report.warnings.push(`${name}: the extension is unknown to us`);
        }
    }

    if (report.blockers.length || report.warnings.length) {
        (log || rootLogger).warn({
            event: "mint.extensions_inspected",
            mint: key,
            extensions: report.extensions.map((e) => EXTENSION_NAMES[e] ?? e),
            blockers: report.blockers,
            warnings: report.warnings,
        }, `Mint has notable extensions: ${[...report.blockers, ...report.warnings].join("; ")}`);
    }

    cache.set(key, { at: Date.now(), report });
    return report;
}

/** For tests: clears the parse cache. */
export function clearMintInspectionCache(): void {
    cache.clear();
}
