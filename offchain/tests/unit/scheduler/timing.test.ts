// tests/unit/scheduler/timing.test.ts
// Unit tests for timing and schedule generation

import {
    generateScheduleOffsets,
    createSchedule,
    formatDuration,
} from "../../../scheduler/timing";

describe("generateScheduleOffsets", () => {
    describe("edge cases", () => {
        it("should return empty array for n <= 0", () => {
            expect(generateScheduleOffsets(0, 60000)).toEqual([]);
            expect(generateScheduleOffsets(-1, 60000)).toEqual([]);
        });

        it("should return empty array for windowMs <= 0", () => {
            expect(generateScheduleOffsets(5, 0)).toEqual([]);
            expect(generateScheduleOffsets(5, -1000)).toEqual([]);
        });

        it("should return single offset for n = 1", () => {
            const result = generateScheduleOffsets(1, 60000);
            expect(result).toHaveLength(1);
            expect(result[0]).toBeGreaterThanOrEqual(0);
            expect(result[0]).toBeLessThan(30000); // First half of window
        });
    });

    describe("offset properties", () => {
        it("should return N offsets", () => {
            const result = generateScheduleOffsets(10, 600000);
            expect(result).toHaveLength(10);
        });

        it("should have all offsets within window", () => {
            const windowMs = 600000;
            const result = generateScheduleOffsets(10, windowMs);

            for (const offset of result) {
                expect(offset).toBeGreaterThanOrEqual(0);
                expect(offset).toBeLessThan(windowMs);
            }
        });

        it("should produce offsets in ascending order", () => {
            const result = generateScheduleOffsets(10, 600000);

            for (let i = 1; i < result.length; i++) {
                expect(result[i]).toBeGreaterThan(result[i - 1]);
            }
        });

        it("should respect minimum gap between purchases", () => {
            const minGap = 5000;
            const result = generateScheduleOffsets(10, 600000, minGap);

            for (let i = 1; i < result.length; i++) {
                const gap = result[i] - result[i - 1];
                // Gap should be at least close to minGap (allowing for slot boundaries)
                expect(gap).toBeGreaterThan(minGap / 2);
            }
        });
    });

    describe("distribution", () => {
        it("should distribute offsets across the window", () => {
            const windowMs = 600000; // 10 minutes
            const n = 10;
            const result = generateScheduleOffsets(n, windowMs);

            // Check that each offset is roughly in its expected slot
            const slotSize = windowMs / n;
            for (let i = 0; i < n; i++) {
                const slotStart = i * slotSize;
                const slotEnd = (i + 1) * slotSize;
                expect(result[i]).toBeGreaterThanOrEqual(slotStart);
                expect(result[i]).toBeLessThanOrEqual(slotEnd);
            }
        });
    });

    describe("randomness", () => {
        it("should produce different offsets on multiple calls", () => {
            const result1 = generateScheduleOffsets(10, 600000);
            const result2 = generateScheduleOffsets(10, 600000);

            const identical = result1.every((v: number, i: number) => v === result2[i]);
            expect(identical).toBe(false);
        });
    });
});

describe("createSchedule", () => {
    it("should create absolute timestamps from start time", () => {
        const startTime = 1700000000000;
        const result = createSchedule(5, startTime, 10);

        for (const timestamp of result) {
            expect(timestamp).toBeGreaterThanOrEqual(startTime);
            expect(timestamp).toBeLessThan(startTime + 10 * 60 * 1000);
        }
    });

    it("should return N timestamps", () => {
        const result = createSchedule(20, Date.now(), 50);
        expect(result).toHaveLength(20);
    });

    it("should produce ordered timestamps", () => {
        const result = createSchedule(10, Date.now(), 50);

        for (let i = 1; i < result.length; i++) {
            expect(result[i]).toBeGreaterThan(result[i - 1]);
        }
    });

    it("should fit within window", () => {
        const startTime = Date.now();
        const windowMinutes = 50;
        const windowMs = windowMinutes * 60 * 1000;
        const result = createSchedule(10, startTime, windowMinutes);

        for (const timestamp of result) {
            expect(timestamp - startTime).toBeLessThan(windowMs);
        }
    });
});

describe("formatDuration", () => {
    describe("seconds", () => {
        it("should format pure seconds", () => {
            expect(formatDuration(5000)).toBe("5s");
            expect(formatDuration(30000)).toBe("30s");
            expect(formatDuration(59000)).toBe("59s");
        });

        it("should handle sub-second as 0s", () => {
            expect(formatDuration(500)).toBe("0s");
            expect(formatDuration(999)).toBe("0s");
        });
    });

    describe("minutes and seconds", () => {
        it("should format minutes and seconds", () => {
            expect(formatDuration(60000)).toBe("1m 0s");
            expect(formatDuration(90000)).toBe("1m 30s");
            expect(formatDuration(330000)).toBe("5m 30s");
        });

        it("should handle exact minutes", () => {
            expect(formatDuration(300000)).toBe("5m 0s");
            expect(formatDuration(600000)).toBe("10m 0s");
        });
    });

    describe("hours and minutes", () => {
        it("should format hours and minutes", () => {
            expect(formatDuration(3600000)).toBe("1h 0m");
            expect(formatDuration(5400000)).toBe("1h 30m");
            expect(formatDuration(5000000)).toBe("1h 23m");
        });

        it("should handle multiple hours", () => {
            expect(formatDuration(7200000)).toBe("2h 0m");
            expect(formatDuration(10800000)).toBe("3h 0m");
        });
    });
});
