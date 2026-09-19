// tests/unit/dex/fetchWithTimeout.test.ts
// Unit tests for fetchWithTimeout

import { fetchWithTimeout, isJupiterNoRouteErrorBody } from "../../../dex/buy";

// =============================================================================
// MOCKS
// =============================================================================

const originalFetch = global.fetch;

afterEach(() => {
    global.fetch = originalFetch;
    jest.useRealTimers();
});

// =============================================================================
// TESTS
// =============================================================================

describe("fetchWithTimeout", () => {
    describe("successful requests", () => {
        it("should return response on successful fetch", async () => {
            const mockResponse = new Response(JSON.stringify({ ok: true }), {
                status: 200,
            });
            global.fetch = jest.fn().mockResolvedValue(mockResponse);

            const result = await fetchWithTimeout("https://example.com");

            expect(result).toBe(mockResponse);
            expect(global.fetch).toHaveBeenCalledWith(
                "https://example.com",
                expect.objectContaining({ signal: expect.any(AbortSignal) })
            );
        });

        it("should pass options to fetch", async () => {
            const mockResponse = new Response("ok");
            global.fetch = jest.fn().mockResolvedValue(mockResponse);

            await fetchWithTimeout("https://example.com", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: '{"test":true}',
            });

            expect(global.fetch).toHaveBeenCalledWith(
                "https://example.com",
                expect.objectContaining({
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: '{"test":true}',
                    signal: expect.any(AbortSignal),
                })
            );
        });

        it("should handle URL object", async () => {
            const mockResponse = new Response("ok");
            global.fetch = jest.fn().mockResolvedValue(mockResponse);

            const url = new URL("https://example.com/path?query=1");
            await fetchWithTimeout(url);

            expect(global.fetch).toHaveBeenCalledWith(
                "https://example.com/path?query=1",
                expect.any(Object)
            );
        });
    });

    describe("timeout handling", () => {
        it("should throw timeout error when request exceeds timeout", async () => {
            jest.useFakeTimers();

            global.fetch = jest.fn().mockImplementation(
                (_url, options) =>
                    new Promise((_resolve, reject) => {
                        options?.signal?.addEventListener("abort", () => {
                            const error = new Error("Aborted");
                            error.name = "AbortError";
                            reject(error);
                        });
                    })
            );

            const promise = fetchWithTimeout("https://example.com", {}, 100);

            jest.advanceTimersByTime(100);

            await expect(promise).rejects.toThrow("Request timeout after 100ms");
        });

        it("should use custom timeout value", async () => {
            jest.useFakeTimers();

            global.fetch = jest.fn().mockImplementation(
                (_url, options) =>
                    new Promise((_resolve, reject) => {
                        options?.signal?.addEventListener("abort", () => {
                            const error = new Error("Aborted");
                            error.name = "AbortError";
                            reject(error);
                        });
                    })
            );

            const promise = fetchWithTimeout("https://example.com", {}, 5000);

            jest.advanceTimersByTime(4999);
            expect(global.fetch).toHaveBeenCalled();

            jest.advanceTimersByTime(1);

            await expect(promise).rejects.toThrow("Request timeout after 5000ms");
        });
    });

    describe("error handling", () => {
        it("should propagate network errors", async () => {
            const networkError = new Error("Network error");
            global.fetch = jest.fn().mockRejectedValue(networkError);

            await expect(fetchWithTimeout("https://example.com")).rejects.toThrow(
                "Network error"
            );
        });

        it("should propagate non-AbortError errors as-is", async () => {
            const customError = new Error("Custom error");
            customError.name = "CustomError";
            global.fetch = jest.fn().mockRejectedValue(customError);

            await expect(fetchWithTimeout("https://example.com")).rejects.toThrow(
                "Custom error"
            );
        });
    });
});

describe("isJupiterNoRouteErrorBody", () => {
    it.each([
        '{"errorCode":"TOKEN_NOT_TRADABLE","error":"Token is not tradable"}',
        '{"errorCode":"COULD_NOT_FIND_ANY_ROUTE","error":"Could not find any route"}',
        '{"errorCode":"NO_ROUTES_FOUND"}',
        '{"errorCode":"ROUTE_PLAN_DOES_NOT_CONSUME_ALL_THE_AMOUNT"}',
        '{"errorCode":"MARKET_NOT_FOUND"}',
        "No routes found for token",
    ])("detects route errors: %s", (body) => {
        expect(isJupiterNoRouteErrorBody(body)).toBe(true);
    });

    it.each([
        '{"errorCode":"INVALID_REQUEST","error":"amount must be positive"}',
        '{"error":"Internal server error"}',
        "Jupiter quote failed: 500 Service Unavailable",
    ])("does not treat non-route errors as route errors: %s", (body) => {
        expect(isJupiterNoRouteErrorBody(body)).toBe(false);
    });
});
