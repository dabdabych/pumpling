// api/validation.ts
// Request validation + base58 → PublicKey conversion

import { Keypair, PublicKey } from "@solana/web3.js";
import { ExecuteLotteryParams, TokenEntry, RecipientEntry } from "../orchestrator/types";

// =============================================================================
// ERRORS
// =============================================================================

export class ValidationError extends Error {
    constructor(
        message: string,
        public readonly details: string[]
    ) {
        super(message);
        this.name = "ValidationError";
    }
}

// =============================================================================
// RAW REQUEST TYPES (base58 strings from JSON)
// =============================================================================

export interface RawRecipient {
    publickey: string;
    amount: number;    // SOL bet (not lamports)
    /** The same commit in lamports, decimal string. Optional. */
    amountLamports?: string;
    /** Share of this wallet's tokens to burn, 0..10000, commit-weighted. Optional. */
    burnBps?: number;
    /** Σ(lamports × bps) over the wallet's commits, decimal string. Optional. */
    burnWeight?: string;
}

/**
 * How far `amountLamports` may sit from `amount`. The backend sends `amount`
 * rounded to eight decimals, which alone is up to 5 lamports; anything past
 * this is two different numbers, not rounding.
 */
const AMOUNT_TOLERANCE_LAMPORTS = 1_000n;

export interface RawToken {
    mint: string;
    totalSol: number;  // SOL (not lamports)
    recipients: RawRecipient[];
}

// =============================================================================
// VALIDATION
// =============================================================================

const LOTTERY_ID_RE = /^[a-zA-Z0-9_-]+$/;
const MAX_TOKENS = 100;

export function validateAndConvert(
    body: unknown,
    keeper: Keypair
): ExecuteLotteryParams {
    const errors: string[] = [];

    if (!body || typeof body !== "object") {
        throw new ValidationError("Request body must be a JSON object", [
            "Expected object, got " + typeof body,
        ]);
    }

    const req = body as Record<string, unknown>;

    // lotteryId
    if (typeof req.lotteryId !== "string" || req.lotteryId.length === 0) {
        errors.push("lotteryId: must be a non-empty string");
    } else if (!LOTTERY_ID_RE.test(req.lotteryId)) {
        errors.push(
            "lotteryId: must contain only alphanumeric characters, hyphens, and underscores"
        );
    }

    // tokens array
    if (!Array.isArray(req.tokens)) {
        errors.push("tokens: must be an array");
        throw new ValidationError("Invalid request", errors);
    }

    if (req.tokens.length === 0) {
        errors.push("tokens: must contain at least 1 token");
    }

    if (req.tokens.length > MAX_TOKENS) {
        errors.push(`tokens: maximum ${MAX_TOKENS} tokens allowed`);
    }

    // Validate each token
    const seenMints = new Set<string>();
    const tokens: TokenEntry[] = [];

    for (let i = 0; i < req.tokens.length; i++) {
        const raw = req.tokens[i] as Record<string, unknown>;
        const prefix = `tokens[${i}]`;

        // mint
        let mint: PublicKey | null = null;
        if (typeof raw.mint !== "string" || raw.mint.length === 0) {
            errors.push(`${prefix}.mint: must be a non-empty string`);
        } else {
            try {
                mint = new PublicKey(raw.mint);
            } catch {
                errors.push(`${prefix}.mint: invalid base58 public key`);
            }

            if (seenMints.has(raw.mint)) {
                errors.push(`${prefix}.mint: duplicate mint ${raw.mint}`);
            }
            seenMints.add(raw.mint);
        }

        // totalSol
        if (typeof raw.totalSol !== "number" || !Number.isFinite(raw.totalSol) || raw.totalSol <= 0) {
            errors.push(`${prefix}.totalSol: must be a positive number`);
        }

        // recipients
        if (!Array.isArray(raw.recipients)) {
            errors.push(`${prefix}.recipients: must be an array`);
            continue;
        }

        if (raw.recipients.length === 0) {
            errors.push(`${prefix}.recipients: must contain at least 1 recipient`);
        }

        const recipients: RecipientEntry[] = [];

        for (let j = 0; j < raw.recipients.length; j++) {
            const rRaw = raw.recipients[j] as Record<string, unknown>;
            const rPrefix = `${prefix}.recipients[${j}]`;

            let recipientKey: PublicKey | null = null;
            if (
                typeof rRaw.publickey !== "string" ||
                rRaw.publickey.length === 0
            ) {
                errors.push(`${rPrefix}.publickey: must be a non-empty string`);
            } else {
                try {
                    recipientKey = new PublicKey(rRaw.publickey);
                } catch {
                    errors.push(
                        `${rPrefix}.publickey: invalid base58 public key`
                    );
                }
            }

            if (typeof rRaw.amount !== "number" || !Number.isFinite(rRaw.amount) || rRaw.amount <= 0) {
                errors.push(`${rPrefix}.amount: must be a positive number`);
            }

            const burn = validateBurnFields(rRaw, rPrefix, errors);

            if (recipientKey && typeof rRaw.amount === "number" && rRaw.amount > 0 && burn) {
                recipients.push({
                    publickey: recipientKey,
                    amount: rRaw.amount,
                    ...burn,
                });
            }
        }

        if (mint && typeof raw.totalSol === "number" && raw.totalSol > 0 && recipients.length > 0) {
            tokens.push({
                mint,
                totalSol: raw.totalSol,
                recipients,
            });
        }
    }

    if (errors.length > 0) {
        throw new ValidationError("Invalid request", errors);
    }

    return {
        lotteryId: req.lotteryId as string,
        tokens,
        keeper,
    };
}

/**
 * The burn fields of one recipient, checked.
 *
 * They are optional, and a payload without them is a round nobody burns in —
 * that is every round before the burn existed. When they are there they have to
 * make sense together: a burn weight is a claim on other people's tokens being
 * destroyed, so a malformed one stops the round rather than being guessed at.
 *
 * @returns the fields to keep, or null when one of them is wrong.
 */
function validateBurnFields(
    raw: Record<string, unknown>,
    prefix: string,
    errors: string[]
): Pick<RecipientEntry, "amountLamports" | "burnBps" | "burnWeight"> | null {
    const before = errors.length;
    const out: Pick<RecipientEntry, "amountLamports" | "burnBps" | "burnWeight"> = {};

    let stake: bigint | null = null;
    if (raw.amountLamports !== undefined) {
        if (typeof raw.amountLamports !== "string" || !/^[1-9]\d*$/.test(raw.amountLamports)) {
            errors.push(`${prefix}.amountLamports: must be a positive integer as a decimal string`);
        } else {
            stake = BigInt(raw.amountLamports);
            if (typeof raw.amount === "number" && Number.isFinite(raw.amount)) {
                const fromAmount = BigInt(Math.round(raw.amount * 1e9));
                const gap = stake > fromAmount ? stake - fromAmount : fromAmount - stake;
                if (gap > AMOUNT_TOLERANCE_LAMPORTS) {
                    errors.push(`${prefix}.amountLamports: ${raw.amountLamports} does not match amount ${raw.amount}`);
                }
            }
            out.amountLamports = raw.amountLamports;
        }
    }
    if (stake === null && typeof raw.amount === "number" && Number.isFinite(raw.amount)) {
        stake = BigInt(Math.round(raw.amount * 1e9));
    }

    if (raw.burnBps !== undefined) {
        if (typeof raw.burnBps !== "number" || !Number.isFinite(raw.burnBps) || raw.burnBps < 0 || raw.burnBps > 10_000) {
            errors.push(`${prefix}.burnBps: must be a number from 0 to 10000`);
        } else {
            out.burnBps = raw.burnBps;
        }
    }

    if (raw.burnWeight !== undefined) {
        if (typeof raw.burnWeight !== "string" || !/^\d+$/.test(raw.burnWeight)) {
            errors.push(`${prefix}.burnWeight: must be a non-negative integer as a decimal string`);
        } else if (stake !== null && BigInt(raw.burnWeight) > stake * 10_000n) {
            errors.push(`${prefix}.burnWeight: more than the whole commit`);
        } else {
            out.burnWeight = raw.burnWeight;
            // Both forms given: they must say the same thing, to within the
            // rounding of the display figure.
            if (out.burnBps !== undefined && stake !== null && stake > 0n) {
                const exact = Number((BigInt(raw.burnWeight) * 100n) / stake) / 100;
                if (Math.abs(exact - out.burnBps) > 1) {
                    errors.push(`${prefix}.burnWeight: says ${exact} bps, burnBps says ${out.burnBps}`);
                }
            }
        }
    }

    return errors.length === before ? out : null;
}
