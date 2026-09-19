// tests/unit/scheduler/slippage.test.ts
// Unit tests for slippage escalation strategy

import {
    getSlippageForAttempt,
    canRetry,
    formatSlippage,
    SLIPPAGE_SCHEDULE_BPS,
    MAX_RETRIES,
} from "../../../scheduler/slippage";

describe("getSlippageForAttempt", () => {
    const MAX_SLIPPAGE = 1300;

    describe("uses startSlippageBps for attempt 1", () => {
        it("should return startSlippageBps on first attempt", () => {
            expect(getSlippageForAttempt(1, 100, MAX_SLIPPAGE)).toBe(100);
            expect(getSlippageForAttempt(1, 300, MAX_SLIPPAGE)).toBe(300);
            expect(getSlippageForAttempt(1, 500, MAX_SLIPPAGE)).toBe(500);
        });

        it("should cap startSlippageBps at maxSlippageBps", () => {
            expect(getSlippageForAttempt(1, 3000, MAX_SLIPPAGE)).toBe(1300);
        });
    });

    describe("escalation from startSlippageBps=300 (default)", () => {
        it("should escalate: 300 → 500 → 900 → 1300", () => {
            expect(getSlippageForAttempt(1, 300, MAX_SLIPPAGE)).toBe(300);
            expect(getSlippageForAttempt(2, 300, MAX_SLIPPAGE)).toBe(500);
            expect(getSlippageForAttempt(3, 300, MAX_SLIPPAGE)).toBe(900);
            expect(getSlippageForAttempt(4, 300, MAX_SLIPPAGE)).toBe(1300);
        });
    });

    describe("escalation from startSlippageBps=100", () => {
        it("should escalate: 100 → 300 → 500 → 900", () => {
            expect(getSlippageForAttempt(1, 100, MAX_SLIPPAGE)).toBe(100);
            expect(getSlippageForAttempt(2, 100, MAX_SLIPPAGE)).toBe(300);
            expect(getSlippageForAttempt(3, 100, MAX_SLIPPAGE)).toBe(500);
            expect(getSlippageForAttempt(4, 100, MAX_SLIPPAGE)).toBe(900);
        });

        it("should cap at last escalation step for high attempts", () => {
            expect(getSlippageForAttempt(10, 100, MAX_SLIPPAGE)).toBe(1300);
        });
    });

    describe("escalation from startSlippageBps=500", () => {
        it("should escalate: 500 → 900 → 1300", () => {
            expect(getSlippageForAttempt(1, 500, MAX_SLIPPAGE)).toBe(500);
            expect(getSlippageForAttempt(2, 500, MAX_SLIPPAGE)).toBe(900);
            expect(getSlippageForAttempt(3, 500, MAX_SLIPPAGE)).toBe(1300);
            expect(getSlippageForAttempt(4, 500, MAX_SLIPPAGE)).toBe(1300);
        });
    });

    describe("startSlippageBps >= all schedule entries", () => {
        it("should stay at startSlippageBps when no escalation steps above", () => {
            expect(getSlippageForAttempt(1, 2000, MAX_SLIPPAGE)).toBe(1300);
            expect(getSlippageForAttempt(2, 2000, MAX_SLIPPAGE)).toBe(1300);
            expect(getSlippageForAttempt(3, 2500, 3000)).toBe(2500);
        });
    });

    describe("max slippage capping", () => {
        it("should cap escalation at maxSlippageBps", () => {
            expect(getSlippageForAttempt(3, 300, 500)).toBe(500);
            expect(getSlippageForAttempt(4, 300, 800)).toBe(800);
        });

        it("should return escalation value when below max", () => {
            expect(getSlippageForAttempt(2, 300, 1000)).toBe(500);
        });
    });

    describe("edge cases", () => {
        it("should return startSlippageBps for attempt <= 0", () => {
            expect(getSlippageForAttempt(0, 100, MAX_SLIPPAGE)).toBe(100);
            expect(getSlippageForAttempt(-1, 300, MAX_SLIPPAGE)).toBe(300);
        });
    });

    describe("SLIPPAGE_SCHEDULE_BPS constant", () => {
        it("should have 4 entries", () => {
            expect(SLIPPAGE_SCHEDULE_BPS).toEqual([300, 500, 900, 1300]);
        });
    });
});

describe("canRetry", () => {
    describe("retry limits", () => {
        it("should allow first attempt (0 previous attempts)", () => {
            expect(canRetry(0)).toBe(true);
        });

        it("should allow retries up to MAX_RETRIES", () => {
            for (let i = 1; i <= MAX_RETRIES; i++) {
                expect(canRetry(i)).toBe(true);
            }
        });

        it("should not allow retry after MAX_RETRIES+1 attempts", () => {
            expect(canRetry(MAX_RETRIES + 1)).toBe(false);
        });

        it("should not allow retry after many attempts", () => {
            expect(canRetry(10)).toBe(false);
        });
    });

    describe("MAX_RETRIES constant", () => {
        it("should be 3 (4 total attempts)", () => {
            expect(MAX_RETRIES).toBe(3);
        });
    });
});

describe("formatSlippage", () => {
    describe("formatting", () => {
        it("should format 100 bps as 1.0%", () => {
            expect(formatSlippage(100)).toBe("1.0%");
        });

        it("should format 150 bps as 1.5%", () => {
            expect(formatSlippage(150)).toBe("1.5%");
        });

        it("should format 500 bps as 5.0%", () => {
            expect(formatSlippage(500)).toBe("5.0%");
        });

        it("should format 1000 bps as 10.0%", () => {
            expect(formatSlippage(1000)).toBe("10.0%");
        });

        it("should format 2000 bps as 20.0%", () => {
            expect(formatSlippage(2000)).toBe("20.0%");
        });

        it("should format small values", () => {
            expect(formatSlippage(10)).toBe("0.1%");
            expect(formatSlippage(50)).toBe("0.5%");
        });
    });
});
