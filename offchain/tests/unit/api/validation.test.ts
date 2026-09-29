// tests/unit/api/validation.test.ts

import { Keypair, PublicKey } from "@solana/web3.js";
import { validateAndConvert, ValidationError } from "../../../api/validation";

const keeper = Keypair.generate();
const validMint = Keypair.generate().publicKey.toBase58();
const validRecipient = Keypair.generate().publicKey.toBase58();

function validBody(overrides: Record<string, unknown> = {}) {
    return {
        lotteryId: "lottery_001",
        tokens: [
            {
                mint: validMint,
                totalSol: 1.5,
                recipients: [
                    { publickey: validRecipient, amount: 10 },
                ],
            },
        ],
        ...overrides,
    };
}

describe("validateAndConvert", () => {
    // =========================================================================
    // HAPPY PATH
    // =========================================================================

    it("should convert valid request to ExecuteLotteryParams", () => {
        const result = validateAndConvert(validBody(), keeper);

        expect(result.lotteryId).toBe("lottery_001");
        expect(result.keeper).toBe(keeper);
        expect(result.tokens).toHaveLength(1);
        expect(result.tokens[0].mint).toBeInstanceOf(PublicKey);
        expect(result.tokens[0].mint.toBase58()).toBe(validMint);
        expect(result.tokens[0].totalSol).toBe(1.5);
        expect(result.tokens[0].recipients).toHaveLength(1);
        expect(result.tokens[0].recipients[0].publickey).toBeInstanceOf(PublicKey);
        expect(result.tokens[0].recipients[0].amount).toBe(10);
    });

    it("should accept lotteryId with hyphens and underscores", () => {
        const result = validateAndConvert(
            validBody({ lotteryId: "my-lottery_123" }),
            keeper
        );
        expect(result.lotteryId).toBe("my-lottery_123");
    });

    it("should accept multiple tokens and recipients", () => {
        const mint2 = Keypair.generate().publicKey.toBase58();
        const rec2 = Keypair.generate().publicKey.toBase58();

        const body = validBody({
            tokens: [
                {
                    mint: validMint,
                    totalSol: 1,
                    recipients: [
                        { publickey: validRecipient, amount: 5 },
                        { publickey: rec2, amount: 3 },
                    ],
                },
                {
                    mint: mint2,
                    totalSol: 2,
                    recipients: [{ publickey: validRecipient, amount: 10 }],
                },
            ],
        });

        const result = validateAndConvert(body, keeper);
        expect(result.tokens).toHaveLength(2);
        expect(result.tokens[0].recipients).toHaveLength(2);
    });

    // =========================================================================
    // BODY-LEVEL ERRORS
    // =========================================================================

    it("should reject null body", () => {
        expect(() => validateAndConvert(null, keeper)).toThrow(ValidationError);
    });

    it("should reject non-object body", () => {
        expect(() => validateAndConvert("string", keeper)).toThrow(ValidationError);
    });

    // =========================================================================
    // LOTTERY ID ERRORS
    // =========================================================================

    it("should reject missing lotteryId", () => {
        const body = validBody();
        delete (body as Record<string, unknown>).lotteryId;

        expect(() => validateAndConvert(body, keeper)).toThrow(ValidationError);
        try {
            validateAndConvert(body, keeper);
        } catch (e) {
            expect((e as ValidationError).details).toContainEqual(
                expect.stringContaining("lotteryId")
            );
        }
    });

    it("should reject empty lotteryId", () => {
        expect(() =>
            validateAndConvert(validBody({ lotteryId: "" }), keeper)
        ).toThrow(ValidationError);
    });

    it("should reject lotteryId with special characters", () => {
        expect(() =>
            validateAndConvert(validBody({ lotteryId: "lot tery!@#" }), keeper)
        ).toThrow(ValidationError);
    });

    // =========================================================================
    // TOKENS ARRAY ERRORS
    // =========================================================================

    it("should reject non-array tokens", () => {
        expect(() =>
            validateAndConvert(validBody({ tokens: "not-array" }), keeper)
        ).toThrow(ValidationError);
    });

    it("should reject empty tokens array", () => {
        expect(() =>
            validateAndConvert(validBody({ tokens: [] }), keeper)
        ).toThrow(ValidationError);
    });

    it("should reject more than 100 tokens", () => {
        const tokens = Array.from({ length: 101 }, (_, i) => ({
            mint: Keypair.generate().publicKey.toBase58(),
            totalSol: 0.1,
            recipients: [{ publickey: validRecipient, amount: 1 }],
        }));

        expect(() =>
            validateAndConvert(validBody({ tokens }), keeper)
        ).toThrow(ValidationError);
    });

    // =========================================================================
    // MINT ERRORS
    // =========================================================================

    it("should reject invalid base58 mint", () => {
        const body = validBody({
            tokens: [
                {
                    mint: "not-a-valid-base58!!!",
                    totalSol: 1,
                    recipients: [{ publickey: validRecipient, amount: 1 }],
                },
            ],
        });

        expect(() => validateAndConvert(body, keeper)).toThrow(ValidationError);
    });

    it("should reject duplicate mints", () => {
        const body = validBody({
            tokens: [
                {
                    mint: validMint,
                    totalSol: 1,
                    recipients: [{ publickey: validRecipient, amount: 1 }],
                },
                {
                    mint: validMint,
                    totalSol: 2,
                    recipients: [{ publickey: validRecipient, amount: 1 }],
                },
            ],
        });

        expect(() => validateAndConvert(body, keeper)).toThrow(ValidationError);
        try {
            validateAndConvert(body, keeper);
        } catch (e) {
            expect((e as ValidationError).details).toContainEqual(
                expect.stringContaining("duplicate")
            );
        }
    });

    // =========================================================================
    // TOTAL SOL ERRORS
    // =========================================================================

    it("should reject zero totalSol", () => {
        const body = validBody({
            tokens: [
                {
                    mint: validMint,
                    totalSol: 0,
                    recipients: [{ publickey: validRecipient, amount: 1 }],
                },
            ],
        });

        expect(() => validateAndConvert(body, keeper)).toThrow(ValidationError);
    });

    it("should reject negative totalSol", () => {
        const body = validBody({
            tokens: [
                {
                    mint: validMint,
                    totalSol: -1,
                    recipients: [{ publickey: validRecipient, amount: 1 }],
                },
            ],
        });

        expect(() => validateAndConvert(body, keeper)).toThrow(ValidationError);
    });

    // =========================================================================
    // RECIPIENT ERRORS
    // =========================================================================

    it("should reject empty recipients", () => {
        const body = validBody({
            tokens: [
                {
                    mint: validMint,
                    totalSol: 1,
                    recipients: [],
                },
            ],
        });

        expect(() => validateAndConvert(body, keeper)).toThrow(ValidationError);
    });

    it("should reject invalid recipient publickey", () => {
        const body = validBody({
            tokens: [
                {
                    mint: validMint,
                    totalSol: 1,
                    recipients: [{ publickey: "bad-key!!!", amount: 1 }],
                },
            ],
        });

        expect(() => validateAndConvert(body, keeper)).toThrow(ValidationError);
    });

    it("should reject zero recipient amount", () => {
        const body = validBody({
            tokens: [
                {
                    mint: validMint,
                    totalSol: 1,
                    recipients: [{ publickey: validRecipient, amount: 0 }],
                },
            ],
        });

        expect(() => validateAndConvert(body, keeper)).toThrow(ValidationError);
    });

    it("should reject negative recipient amount", () => {
        const body = validBody({
            tokens: [
                {
                    mint: validMint,
                    totalSol: 1,
                    recipients: [{ publickey: validRecipient, amount: -5 }],
                },
            ],
        });

        expect(() => validateAndConvert(body, keeper)).toThrow(ValidationError);
    });

    // =========================================================================
    // MULTIPLE ERRORS
    // =========================================================================

    it("should collect multiple errors", () => {
        const body = {
            lotteryId: "",
            tokens: [
                {
                    mint: "bad",
                    totalSol: -1,
                    recipients: [],
                },
            ],
        };

        try {
            validateAndConvert(body, keeper);
            fail("Should have thrown");
        } catch (e) {
            const err = e as ValidationError;
            expect(err.details.length).toBeGreaterThanOrEqual(3);
        }
    });
});

describe("validateAndConvert: the burn fields", () => {
    const withRecipient = (recipient: Record<string, unknown>) =>
        validBody({ tokens: [{ mint: validMint, totalSol: 1.5, recipients: [{ publickey: validRecipient, amount: 10, ...recipient }] }] });

    const details = (body: unknown): string[] => {
        try {
            validateAndConvert(body, keeper);
        } catch (e) {
            return (e as ValidationError).details;
        }
        return [];
    };

    it("a payload without them is a round nobody burns in, as before", () => {
        const recipient = validateAndConvert(validBody(), keeper).tokens[0].recipients[0];
        expect(recipient.burnBps).toBeUndefined();
        expect(recipient.burnWeight).toBeUndefined();
        expect(recipient.amountLamports).toBeUndefined();
    });

    it("keeps them when they agree with each other and with the amount", () => {
        const recipient = validateAndConvert(
            withRecipient({ amountLamports: "10000000000", burnBps: 5000, burnWeight: "50000000000000" }),
            keeper
        ).tokens[0].recipients[0];
        expect(recipient).toMatchObject({ amountLamports: "10000000000", burnBps: 5000, burnWeight: "50000000000000" });
    });

    it("tolerates the rounding of an amount sent to eight decimals, and nothing more", () => {
        expect(details(withRecipient({ amount: 0.12345679, amountLamports: "123456789" }))).toEqual([]);
        expect(details(withRecipient({ amount: 10, amountLamports: "10000002000" }))[0]).toMatch(/does not match amount/);
    });

    it("refuses a burn weight above the whole commit", () => {
        expect(details(withRecipient({ amountLamports: "10000000000", burnWeight: "100000000000001" }))[0])
            .toMatch(/more than the whole commit/);
    });

    it("refuses basis points outside 0..10000 and anything that is not a number", () => {
        expect(details(withRecipient({ burnBps: 10_001 }))[0]).toMatch(/burnBps/);
        expect(details(withRecipient({ burnBps: -1 }))[0]).toMatch(/burnBps/);
        expect(details(withRecipient({ burnBps: "5000" }))[0]).toMatch(/burnBps/);
    });

    it("refuses malformed integers", () => {
        expect(details(withRecipient({ amountLamports: "1e10" }))[0]).toMatch(/amountLamports/);
        expect(details(withRecipient({ amountLamports: 10_000_000_000 }))[0]).toMatch(/amountLamports/);
        expect(details(withRecipient({ burnWeight: "-5" }))[0]).toMatch(/burnWeight/);
        expect(details(withRecipient({ burnWeight: 5 }))[0]).toMatch(/burnWeight/);
    });

    it("refuses a display figure that says something else than the weight", () => {
        expect(details(withRecipient({ amountLamports: "10000000000", burnBps: 2500, burnWeight: "50000000000000" }))[0])
            .toMatch(/says 5000 bps, burnBps says 2500/);
    });
});

describe("the payload contract with the backend", () => {
    // The same file the backend's test builds from bets:
    // webapp/backend/tests/test_purchases_payload_burn.py.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const contract = require("../fixtures/payload-contract.json") as {
        mint: string;
        recipients: Array<Record<string, unknown>>;
        shares: Array<{ wallet: string; stake: string; burn: string }>;
    };

    it("the buyer accepts what the backend sends and reads the exact shares from it", () => {
        const { burnWeightOf } = jest.requireActual("../../../orchestrator/shares");
        const params = validateAndConvert(
            { lotteryId: "contract", tokens: [{ mint: contract.mint, totalSol: 1, recipients: contract.recipients }] },
            keeper
        );
        const recipients = params.tokens[0].recipients;
        expect(recipients.map((r) => ({
            wallet: r.publickey.toBase58(),
            stake: r.amountLamports,
            burn: String(burnWeightOf(BigInt(r.amountLamports!), r.burnWeight, r.burnBps)),
        }))).toEqual(contract.shares);
    });
});
