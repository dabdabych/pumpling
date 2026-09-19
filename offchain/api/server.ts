// api/server.ts
// Express server — REST API for the lottery buyer

import "dotenv/config";
import express from "express";
import { Keypair } from "@solana/web3.js";
import { createRouter } from "./routes";
import { connection } from "../solana/connection";
import { logger } from "../logger";

// =============================================================================
// KEEPER
// =============================================================================

function loadKeeper(): Keypair {
    const secret = process.env.KEEPER_SECRET_KEY;
    if (!secret) {
        throw new Error("KEEPER_SECRET_KEY not set in .env");
    }
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(secret)));
}

// =============================================================================
// SERVER
// =============================================================================

const PORT = parseInt(process.env.API_PORT || "7657", 10);
const API_KEY = process.env.API_KEY;

const keeper = loadKeeper();
logger.info({ event: "api.keeper_loaded", publicKey: keeper.publicKey.toBase58() }, "Keeper loaded");

if (!API_KEY) {
    logger.warn({ event: "api.no_api_key" }, "API_KEY not set — all requests will be rejected");
}

const HEALTH_TIMEOUT_MS = 5_000;

const app = express();
app.use(express.json({ limit: "5mb" }));

// /health is public — no API key required (for docker healthcheck)
app.get("/health", async (_req, res) => {
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("RPC timeout")), HEALTH_TIMEOUT_MS);
    });
    try {
        const [slot, balanceLamports] = await Promise.race([
            Promise.all([
                connection.getSlot(),
                connection.getBalance(keeper.publicKey),
            ]),
            timeout,
        ]);
        clearTimeout(timer!);
        res.json({
            status: "ok",
            rpc: { slot },
            keeper: {
                publicKey: keeper.publicKey.toBase58(),
                balanceSol: balanceLamports / 1e9,
            },
        });
    } catch (err) {
        clearTimeout(timer!);
        res.status(503).json({
            status: "error",
            error: err instanceof Error ? err.message : String(err),
        });
    }
});

app.use((req, res, next) => {
    if (!API_KEY || req.headers["x-api-key"] !== API_KEY) {
        res.status(401).json({ error: "Unauthorized" });
        return;
    }
    next();
});

const { router, resumeUnfinished, waitForRunning } = createRouter(keeper);
app.use(router);

const server = app.listen(PORT, () => {
    logger.info({ event: "api.listening", port: PORT }, `API server listening on port ${PORT}`);
    // We open the port first and deal with the tails afterwards: otherwise the
    // container's liveness check fails before we finish replaying the last round.
    void resumeUnfinished().catch((err) => {
        logger.error(
            { event: "api.resume_error", error: err instanceof Error ? err.message : String(err) },
            "Failed to resume unfinished lotteries"
        );
    });
});

// Graceful shutdown — waits for active lotteries to finish
function shutdown() {
    logger.info({ event: "api.shutdown_start" }, "Shutting down, waiting for active lotteries...");
    server.close();
    waitForRunning().then(() => {
        logger.info({ event: "api.shutdown_complete" }, "All lotteries finished, exiting");
        process.exit(0);
    });
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
