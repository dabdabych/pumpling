// tests/unit/buy.test.ts
// Unit tests for buy() routing and fallback logic

import { Keypair, PublicKey } from "@solana/web3.js";

// =============================================================================
// MOCKS
// =============================================================================

const mockBuyPumpfun = jest.fn();
const mockBuyDex = jest.fn();
const mockBuyPumpswap = jest.fn();
const mockIsBondingCurveActive = jest.fn();

jest.mock("../../pumpfun/bondingCurve", () => ({
    isBondingCurveActive: (...args: unknown[]) => mockIsBondingCurveActive(...args),
}));

jest.mock("../../pumpfun/buy", () => ({
    buyPumpfun: (...args: unknown[]) => mockBuyPumpfun(...args),
    PostSendError: jest.requireActual("../../pumpfun/buy").PostSendError,
}));

jest.mock("../../dex/buy", () => ({
    buyDex: (...args: unknown[]) => mockBuyDex(...args),
    NoRouteError: jest.requireActual("../../dex/buy").NoRouteError,
}));

jest.mock("../../pumpswap/buy", () => ({
    buyPumpswap: (...args: unknown[]) => mockBuyPumpswap(...args),
}));

// Import after mocks
import { buy } from "../../buy";
import { PostSendError } from "../../pumpfun/buy";
import { NoRouteError } from "../../dex/buy";

// =============================================================================
// SETUP
// =============================================================================

const TEST_MINT = new PublicKey("So11111111111111111111111111111111111111112");
const TEST_KEEPER = Keypair.generate();
const TEST_AMOUNT = 0.1;
const TEST_SLIPPAGE = 500;

beforeEach(() => {
    jest.clearAllMocks();
});

// =============================================================================
// TESTS
// =============================================================================

describe("buy", () => {
    describe("routing logic", () => {
        it("should route to pumpfun when bonding curve is active", async () => {
            mockIsBondingCurveActive.mockResolvedValue(true);
            mockBuyPumpfun.mockResolvedValue("pumpfun-signature");

            const result = await buy(TEST_MINT, TEST_AMOUNT, TEST_KEEPER, TEST_SLIPPAGE);

            expect(mockIsBondingCurveActive).toHaveBeenCalledWith(TEST_MINT, TEST_KEEPER);
            expect(mockBuyPumpfun).toHaveBeenCalledWith(
                TEST_MINT,
                TEST_AMOUNT,
                TEST_KEEPER,
                TEST_SLIPPAGE,
                expect.anything()
            );
            expect(mockBuyDex).not.toHaveBeenCalled();
            expect(result).toEqual({
                signature: "pumpfun-signature",
                venue: "pumpfun",
            });
        });

        it("should route to dex when bonding curve is inactive", async () => {
            mockIsBondingCurveActive.mockResolvedValue(false);
            mockBuyDex.mockResolvedValue("dex-signature");

            const result = await buy(TEST_MINT, TEST_AMOUNT, TEST_KEEPER, TEST_SLIPPAGE);

            expect(mockIsBondingCurveActive).toHaveBeenCalledWith(TEST_MINT, TEST_KEEPER);
            expect(mockBuyPumpfun).not.toHaveBeenCalled();
            expect(mockBuyDex).toHaveBeenCalledWith(
                TEST_MINT,
                TEST_AMOUNT,
                TEST_KEEPER,
                TEST_SLIPPAGE,
                expect.anything()
            );
            expect(result).toEqual({
                signature: "dex-signature",
                venue: "dex",
            });
        });
    });

    describe("fallback logic (pre-send / post-send)", () => {
        it("should fallback to dex on pre-send error (graduation)", async () => {
            mockIsBondingCurveActive.mockResolvedValue(true);
            mockBuyPumpfun.mockRejectedValue(
                new Error("Token graduated (bonding curve complete)")
            );
            mockBuyDex.mockResolvedValue("dex-fallback-signature");

            const result = await buy(TEST_MINT, TEST_AMOUNT, TEST_KEEPER, TEST_SLIPPAGE);

            expect(mockBuyPumpfun).toHaveBeenCalled();
            expect(mockBuyDex).toHaveBeenCalledWith(
                TEST_MINT, TEST_AMOUNT, TEST_KEEPER, TEST_SLIPPAGE, expect.anything()
            );
            expect(result).toEqual({ signature: "dex-fallback-signature", venue: "dex", fallback: true });
        });

        it("should fallback to dex on pre-send error (IDL mismatch)", async () => {
            mockIsBondingCurveActive.mockResolvedValue(true);
            mockBuyPumpfun.mockRejectedValue(
                new Error("discriminator mismatch")
            );
            mockBuyDex.mockResolvedValue("dex-fallback-signature");

            const result = await buy(TEST_MINT, TEST_AMOUNT, TEST_KEEPER, TEST_SLIPPAGE);

            expect(mockBuyDex).toHaveBeenCalled();
            expect(result.venue).toBe("dex");
        });

        it("should fallback to dex on pre-send error (fetch failed)", async () => {
            mockIsBondingCurveActive.mockResolvedValue(true);
            mockBuyPumpfun.mockRejectedValue(
                new Error("Account does not exist")
            );
            mockBuyDex.mockResolvedValue("dex-fallback-signature");

            const result = await buy(TEST_MINT, TEST_AMOUNT, TEST_KEEPER, TEST_SLIPPAGE);

            expect(mockBuyDex).toHaveBeenCalled();
            expect(result.venue).toBe("dex");
        });

        it("should NOT fallback on PostSendError (tx may be in mempool)", async () => {
            mockIsBondingCurveActive.mockResolvedValue(true);
            mockBuyPumpfun.mockRejectedValue(
                new PostSendError("Transaction send/confirm failed: timeout")
            );

            await expect(
                buy(TEST_MINT, TEST_AMOUNT, TEST_KEEPER, TEST_SLIPPAGE)
            ).rejects.toThrow(PostSendError);

            expect(mockBuyDex).not.toHaveBeenCalled();
        });

        it("should NOT fallback on PostSendError (insufficient funds at send)", async () => {
            mockIsBondingCurveActive.mockResolvedValue(true);
            mockBuyPumpfun.mockRejectedValue(
                new PostSendError("Transaction send/confirm failed: insufficient funds")
            );

            await expect(
                buy(TEST_MINT, TEST_AMOUNT, TEST_KEEPER, TEST_SLIPPAGE)
            ).rejects.toThrow(PostSendError);

            expect(mockBuyDex).not.toHaveBeenCalled();
        });

        it("should NOT fallback on PostSendError (slippage on-chain)", async () => {
            mockIsBondingCurveActive.mockResolvedValue(true);
            mockBuyPumpfun.mockRejectedValue(
                new PostSendError("Transaction send/confirm failed: TooMuchSolRequired")
            );

            await expect(
                buy(TEST_MINT, TEST_AMOUNT, TEST_KEEPER, TEST_SLIPPAGE)
            ).rejects.toThrow(PostSendError);

            expect(mockBuyDex).not.toHaveBeenCalled();
        });

        it("should propagate error when pre-send fallback to dex also fails", async () => {
            mockIsBondingCurveActive.mockResolvedValue(true);
            mockBuyPumpfun.mockRejectedValue(new Error("fetch failed"));
            mockBuyDex.mockRejectedValue(new Error("Dex error"));

            await expect(
                buy(TEST_MINT, TEST_AMOUNT, TEST_KEEPER, TEST_SLIPPAGE)
            ).rejects.toThrow("Dex error");

            expect(mockBuyPumpfun).toHaveBeenCalled();
            expect(mockBuyDex).toHaveBeenCalled();
        });

        it("should propagate error when dex fails (no fallback needed)", async () => {
            mockIsBondingCurveActive.mockResolvedValue(false);
            mockBuyDex.mockRejectedValue(new Error("No liquidity"));

            await expect(
                buy(TEST_MINT, TEST_AMOUNT, TEST_KEEPER, TEST_SLIPPAGE)
            ).rejects.toThrow("No liquidity");

            expect(mockBuyPumpfun).not.toHaveBeenCalled();
            expect(mockBuyPumpswap).not.toHaveBeenCalled();
        });
    });

    describe("pumpswap fallback (Jupiter no-route)", () => {
        it("should fallback to pumpswap when graduated token has no Jupiter route", async () => {
            mockIsBondingCurveActive.mockResolvedValue(false);
            mockBuyDex.mockRejectedValue(new NoRouteError("Jupiter has no route"));
            mockBuyPumpswap.mockResolvedValue("pumpswap-signature");

            const result = await buy(TEST_MINT, TEST_AMOUNT, TEST_KEEPER, TEST_SLIPPAGE);

            expect(mockBuyDex).toHaveBeenCalled();
            expect(mockBuyPumpswap).toHaveBeenCalledWith(
                TEST_MINT, TEST_AMOUNT, TEST_KEEPER, TEST_SLIPPAGE, expect.anything()
            );
            expect(result).toEqual({ signature: "pumpswap-signature", venue: "pumpswap", fallback: true });
        });

        it("should NOT fallback to pumpswap on non-route dex errors (may be post-send)", async () => {
            mockIsBondingCurveActive.mockResolvedValue(false);
            mockBuyDex.mockRejectedValue(new Error("confirmed but failed on-chain"));

            await expect(
                buy(TEST_MINT, TEST_AMOUNT, TEST_KEEPER, TEST_SLIPPAGE)
            ).rejects.toThrow("confirmed but failed on-chain");

            expect(mockBuyPumpswap).not.toHaveBeenCalled();
        });

        it("should NOT fallback to pumpswap on DEX PostSendError", async () => {
            mockIsBondingCurveActive.mockResolvedValue(false);
            mockBuyDex.mockRejectedValue(new PostSendError("DEX transaction send/confirm failed", "pending-sig"));

            await expect(
                buy(TEST_MINT, TEST_AMOUNT, TEST_KEEPER, TEST_SLIPPAGE)
            ).rejects.toThrow(PostSendError);

            expect(mockBuyPumpswap).not.toHaveBeenCalled();
        });

        it("should propagate pumpswap error when it also fails", async () => {
            mockIsBondingCurveActive.mockResolvedValue(false);
            mockBuyDex.mockRejectedValue(new NoRouteError("no route"));
            mockBuyPumpswap.mockRejectedValue(new Error("PumpSwap pool empty"));

            await expect(
                buy(TEST_MINT, TEST_AMOUNT, TEST_KEEPER, TEST_SLIPPAGE)
            ).rejects.toThrow("PumpSwap pool empty");

            expect(mockBuyPumpswap).toHaveBeenCalled();
        });

        it("should chain pumpfun→dex→pumpswap on pumpfun pre-send fail + no Jupiter route", async () => {
            mockIsBondingCurveActive.mockResolvedValue(true);
            mockBuyPumpfun.mockRejectedValue(new Error("graduated"));
            mockBuyDex.mockRejectedValue(new NoRouteError("no route"));
            mockBuyPumpswap.mockResolvedValue("pumpswap-signature");

            const result = await buy(TEST_MINT, TEST_AMOUNT, TEST_KEEPER, TEST_SLIPPAGE);

            expect(result).toEqual({ signature: "pumpswap-signature", venue: "pumpswap", fallback: true });
        });
    });

    describe("default slippage", () => {
        it("should use default slippage when not provided", async () => {
            mockIsBondingCurveActive.mockResolvedValue(true);
            mockBuyPumpfun.mockResolvedValue("sig");

            await buy(TEST_MINT, TEST_AMOUNT, TEST_KEEPER);

            expect(mockBuyPumpfun).toHaveBeenCalledWith(
                TEST_MINT,
                TEST_AMOUNT,
                TEST_KEEPER,
                500, // DEFAULT_SLIPPAGE_BPS
                expect.anything()
            );
        });
    });
});

describe("slippage on a live curve does not divert to the DEX", () => {
    // A slippage rejection is an ordinary Error, not a PostSendError, so it
    // used to land in the general "failed pre-send" branch and was swallowed by
    // going to the DEX. The error never reached the 300 -> 500 -> 900 ladder in
    // the scheduler at all, which made the whole ladder dead code on the main path.
    it.each([
        ["the code name is substituted", 'Simulation failed: {"InstructionError":[0,{"Custom":6042}]} (BuySlippageBelowMinTokensOut)'],
        ["a bare number", 'Transaction confirmed but failed on-chain: {"InstructionError":[0,{"Custom":6042}]}'],
    ])("propagates the error upwards (%s)", async (_label, message) => {
        mockIsBondingCurveActive.mockResolvedValue(true);
        mockBuyPumpfun.mockRejectedValue(new Error(message));

        await expect(
            buy(TEST_MINT, TEST_AMOUNT, TEST_KEEPER, TEST_SLIPPAGE)
        ).rejects.toThrow();

        expect(mockBuyDex).not.toHaveBeenCalled();
        expect(mockBuyPumpswap).not.toHaveBeenCalled();
    });

    it("but an ordinary pre-send failure still goes to the DEX", async () => {
        mockIsBondingCurveActive.mockResolvedValue(true);
        mockBuyPumpfun.mockRejectedValue(new Error("fetch failed"));
        mockBuyDex.mockResolvedValue("dex-signature");

        const result = await buy(TEST_MINT, TEST_AMOUNT, TEST_KEEPER, TEST_SLIPPAGE);

        expect(result.venue).toBe("dex");
        expect(mockBuyDex).toHaveBeenCalled();
    });
});

describe("errors are labelled with the venue", () => {
    // The classifier picks its code table by this label. If buy() stops
    // attaching it, a slippage rejection becomes an unrecognised error again.
    const { getErrorVenue } = jest.requireActual("../../solana/transaction");

    it("labels pumpfun", async () => {
        mockIsBondingCurveActive.mockResolvedValue(true);
        mockBuyPumpfun.mockRejectedValue(new Error("Simulation failed: something"));
        mockBuyDex.mockRejectedValue(new Error("DEX simulation failed: something"));

        const err = await buy(TEST_MINT, TEST_AMOUNT, TEST_KEEPER, TEST_SLIPPAGE).catch((e) => e);
        // It was the DEX that failed (pumpfun went to the fallback), so the label is dex
        expect(getErrorVenue(err)).toBe("dex");
    });

    it("labels pumpfun when the fallback is forbidden", async () => {
        mockIsBondingCurveActive.mockResolvedValue(true);
        mockBuyPumpfun.mockRejectedValue(
            new Error('Simulation failed: {"InstructionError":[0,{"Custom":6042}]} (BuySlippageBelowMinTokensOut)')
        );

        const err = await buy(TEST_MINT, TEST_AMOUNT, TEST_KEEPER, TEST_SLIPPAGE).catch((e) => e);
        expect(getErrorVenue(err)).toBe("pumpfun");
        expect(mockBuyDex).not.toHaveBeenCalled();
    });

    it("labels dex", async () => {
        mockIsBondingCurveActive.mockResolvedValue(false);
        mockBuyDex.mockRejectedValue(new Error('DEX simulation failed: {"InstructionError":[3,{"Custom":6001}]}'));

        const err = await buy(TEST_MINT, TEST_AMOUNT, TEST_KEEPER, TEST_SLIPPAGE).catch((e) => e);
        expect(getErrorVenue(err)).toBe("dex");
    });

    it("labels pumpswap", async () => {
        mockIsBondingCurveActive.mockResolvedValue(false);
        mockBuyDex.mockRejectedValue(new NoRouteError("Jupiter has no route"));
        mockBuyPumpswap.mockRejectedValue(
            new Error('PumpSwap simulation failed: {"InstructionError":[2,{"Custom":6040}]}')
        );

        const err = await buy(TEST_MINT, TEST_AMOUNT, TEST_KEEPER, TEST_SLIPPAGE).catch((e) => e);
        expect(getErrorVenue(err)).toBe("pumpswap");
    });
});
