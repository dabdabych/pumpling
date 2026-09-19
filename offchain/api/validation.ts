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
}

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

            if (recipientKey && typeof rRaw.amount === "number" && rRaw.amount > 0) {
                recipients.push({
                    publickey: recipientKey,
                    amount: rRaw.amount,
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
