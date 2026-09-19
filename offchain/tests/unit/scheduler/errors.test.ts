// tests/unit/scheduler/errors.test.ts
// Unit tests for error classification

import {
    classifyError,
    isRetryableError,
    isSlippageError,
    RETRYABLE_PATTERNS,
    NON_RETRYABLE_PATTERNS,
} from "../../../scheduler/errors";
import { tagVenue } from "../../../solana/transaction";
import { PUMP_ERROR_NAMES, extractPumpErrorName } from "../../../pumpfun/errors";

// =============================================================================
// classifyError
// =============================================================================

describe("classifyError", () => {
    describe("retryable errors", () => {
        const retryableCases = [
            ["ECONNREFUSED", "connect ECONNREFUSED 127.0.0.1:8899"],
            ["ECONNRESET", "read ECONNRESET"],
            ["ETIMEDOUT", "connect ETIMEDOUT"],
            ["429", "Server responded with 429 Too Many Requests"],
            ["503", "Service Unavailable"],
            ["blockhash", "Blockhash not found"],
            ["block height", "TransactionExpiredBlockheightExceededError: block height exceeded"],
            ["timeout", "Request timeout after 30000ms"],
            ["slippage", "Slippage tolerance exceeded"],
            ["Jupiter 500", "Jupiter quote failed: 500 Internal Server Error"],
        ];

        it.each(retryableCases)(
            "should classify %s as retryable",
            (_name, message) => {
                const result = classifyError(new Error(message));
                expect(result.errorClass).toBe("retryable");
                expect(result.pattern).not.toBeNull();
            }
        );
    });

    describe("non-retryable errors", () => {
        const nonRetryableCases = [
            ["insufficient funds", "Transaction simulation failed: Error processing Instruction 0: insufficient funds"],
            ["Mint not found", "Mint account not found"],
            ["No route", "No route found for 6tGwYs... - no liquidity or invalid token"],
            ["invalid pubkey", "Invalid public key input"],
            ["Account not found", "Account not found: 7kBq..."],
            ["Jupiter 400", "Jupiter quote failed: 400 Bad Request"],
            ["Pump Global", "Pump Global account not found"],
        ];

        it.each(nonRetryableCases)(
            "should classify %s as non-retryable",
            (_name, message) => {
                const result = classifyError(new Error(message));
                expect(result.errorClass).toBe("non-retryable");
                expect(result.pattern).not.toBeNull();
            }
        );
    });

    describe("unknown errors", () => {
        const unknownCases = [
            "Something completely unexpected happened",
            "VersionedTransaction deserialization failed",
            "Cannot read properties of undefined",
            "",
        ];

        it.each(unknownCases)(
            "should classify unknown error: %s",
            (message) => {
                const result = classifyError(new Error(message));
                expect(result.errorClass).toBe("unknown");
                expect(result.pattern).toBeNull();
            }
        );
    });

    describe("non-Error inputs", () => {
        it("should handle string errors", () => {
            const result = classifyError("insufficient funds for rent");
            expect(result.errorClass).toBe("non-retryable");
        });

        it("should handle unknown objects", () => {
            const result = classifyError({ code: 42 });
            expect(result.errorClass).toBe("unknown");
        });
    });

    describe("priority: non-retryable checked first", () => {
        it("should prefer non-retryable when message matches both", () => {
            // In theory "insufficient funds" + "timeout" in one message
            const error = new Error("insufficient funds after timeout");
            const result = classifyError(error);
            expect(result.errorClass).toBe("non-retryable");
        });
    });
});

// =============================================================================
// isRetryableError
// =============================================================================

describe("isRetryableError", () => {
    it("should return true for retryable errors", () => {
        expect(isRetryableError(new Error("ECONNREFUSED"))).toBe(true);
    });

    it("should return false for non-retryable errors", () => {
        expect(isRetryableError(new Error("insufficient funds"))).toBe(false);
    });

    it("should return true for unknown errors (conservative)", () => {
        expect(isRetryableError(new Error("weird error"))).toBe(true);
    });
});

// =============================================================================
// Pattern lists sanity
// =============================================================================

describe("pattern lists", () => {
    it("should have no duplicates in retryable patterns", () => {
        const unique = new Set(RETRYABLE_PATTERNS);
        expect(unique.size).toBe(RETRYABLE_PATTERNS.length);
    });

    it("should have no duplicates in non-retryable patterns", () => {
        const unique = new Set(NON_RETRYABLE_PATTERNS);
        expect(unique.size).toBe(NON_RETRYABLE_PATTERNS.length);
    });

    it("should have no overlap between retryable and non-retryable", () => {
        const overlap = RETRYABLE_PATTERNS.filter((p) =>
            NON_RETRYABLE_PATTERNS.includes(p)
        );
        expect(overlap).toEqual([]);
    });
});

// =============================================================================
// isSlippageError
// =============================================================================

describe("isSlippageError", () => {
    it("should detect Jupiter slippage errors", () => {
        expect(isSlippageError(new Error("Slippage tolerance exceeded"))).toBe(true);
        expect(isSlippageError(new Error("exceeds desired slippage limit"))).toBe(true);
        expect(isSlippageError(new Error("ExceededSlippageToleranceError"))).toBe(true);
    });

    it("should detect pump.fun slippage errors", () => {
        expect(isSlippageError(new Error("TooMuchSolRequired"))).toBe(true);
        // A bare code is only parsed together with the venue label: 0x1772 is
        // 6002, which on pump.fun is TooMuchSolRequired and on the aggregator is
        // not slippage. Without a label the program is unknown.
        expect(isSlippageError(
            tagVenue(new Error("custom program error: 0x1772"), "pumpfun")
        )).toBe(true);
        expect(isSlippageError(new Error("custom program error: 0x1772"))).toBe(false);
        expect(isSlippageError(
            tagVenue(new Error("DEX: custom program error: 0x1772"), "dex")
        )).toBe(false);
    });

    it("should not match non-slippage errors", () => {
        expect(isSlippageError(new Error("insufficient funds"))).toBe(false);
        expect(isSlippageError(new Error("ECONNREFUSED"))).toBe(false);
        expect(isSlippageError(new Error("Permanent failure"))).toBe(false);
        expect(isSlippageError(new Error("timeout"))).toBe(false);
    });

    it("should handle non-Error values", () => {
        expect(isSlippageError("Slippage error")).toBe(true);
        expect(isSlippageError("random string")).toBe(false);
    });
});

describe("slippage is recognised by the venue label", () => {
    // A regression. An error number belongs to a program: 6001 on Jupiter is
    // slippage, on pump.fun it is AlreadyInitialized. The venue used to be
    // guessed from the substrings "DEX transaction" / "Jupiter", and the real
    // messages went straight past them: dex/buy.ts throws "DEX simulation
    // failed: …", pumpswap/buy.ts — "PumpSwap simulation failed: …".
    // Now buy.ts attaches the label where the venue is known for certain.
    function tagged(venue: "pumpfun" | "dex" | "pumpswap", message: string): Error {
        return tagVenue(new Error(message), venue);
    }
    const onChain = (code: number) =>
        `simulation failed: {"InstructionError":[0,{"Custom":${code}}]}`;

    it("recognises pump.fun codes", () => {
        for (const code of [6002, 6003, 6042]) {
            expect(isSlippageError(tagged("pumpfun", onChain(code)))).toBe(true);
        }
        expect(isSlippageError(tagged("pumpfun", onChain(6001)))).toBe(false);
    });

    it("recognises the Jupiter code, including the simulation format", () => {
        expect(isSlippageError(tagged("dex", `DEX ${onChain(6001)}`))).toBe(true);
        expect(isSlippageError(tagged("dex", "DEX transaction failed: custom program error: 0x1771"))).toBe(true);
        // 6042 on Jupiter is not slippage — another program's table does not apply
        expect(isSlippageError(tagged("dex", `DEX ${onChain(6042)}`))).toBe(false);
    });

    it("recognises PumpSwap codes", () => {
        // pump_amm.json: 6004 ExceededSlippage, 6040 BuySlippageBelowMinBaseAmountOut
        expect(isSlippageError(tagged("pumpswap", `PumpSwap ${onChain(6004)}`))).toBe(true);
        expect(isSlippageError(tagged("pumpswap", `PumpSwap ${onChain(6040)}`))).toBe(true);
        // 6042 is a pump.fun code and has nothing to do with PumpSwap
        expect(isSlippageError(tagged("pumpswap", `PumpSwap ${onChain(6042)}`))).toBe(false);
    });

    it("with no label a bare number is not a diagnosis", () => {
        expect(isSlippageError(new Error(onChain(6042)))).toBe(false);
        expect(isSlippageError(new Error(onChain(6001)))).toBe(false);
    });

    it("an error name in the text works without a label too", () => {
        // pumpfun/buy.ts substitutes the name and the text patterns catch it
        expect(isSlippageError(
            new Error(`Simulation failed: {"InstructionError":[0,{"Custom":6042}]} (BuySlippageBelowMinTokensOut)`)
        )).toBe(true);
    });

    it("labelled slippage is classified as retryable", () => {
        expect(classifyError(tagged("dex", `DEX ${onChain(6001)}`)).errorClass).toBe("retryable");
        expect(classifyError(tagged("pumpswap", `PumpSwap ${onChain(6040)}`)).errorClass).toBe("retryable");
    });
});
