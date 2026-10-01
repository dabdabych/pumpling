// offchain/logger.ts
// Structured logging with pino

import pino from "pino";

/**
 * A credential carried in a URL's query string. The RPC endpoints are Helius
 * URLs with `?api-key=...`, and an error from a call to one can quote the URL
 * whole. The value is what a URL may carry unescaped or percent-encoded, plus
 * the base64 alphabet, so it ends at the first character a JSON line puts
 * after it: a comma, a bracket, a quote, a backslash. An escaped quote stays
 * whole and the line still parses.
 *
 * The same pattern scrubs the Python side (`webapp/backend/shared/log_redaction.py`).
 */
const SECRET_PARAMETER = /\b(api[-_]?key|access[-_]?token|token|secret)=([A-Za-z0-9._~%+/=-]+)/gi;

export function redactSecrets(text: string): string {
    return text.replace(SECRET_PARAMETER, "$1=***");
}

interface LineSink {
    write(line: string): unknown;
}

/**
 * Where the lines go in production: stdout, each finished JSON line scrubbed
 * on the way out. Scrubbing the line rather than the log object covers the
 * message, every field and every serialized error in one place, whatever
 * order pino builds them in.
 */
export function redactingDestination(sink: LineSink = process.stdout): LineSink {
    return { write: (line: string) => sink.write(redactSecrets(line)) };
}

export function createLogger(sink?: LineSink): pino.Logger {
    const level = process.env.LOG_LEVEL || "info";
    if (process.env.NODE_ENV !== "production") {
        // Local runs: pretty output through a worker thread, which a stream
        // cannot wrap. The container sets NODE_ENV=production.
        return pino({ level, transport: { target: "pino-pretty", options: { colorize: true } } });
    }
    return pino({ level }, redactingDestination(sink));
}

export const logger = createLogger();

export type Logger = pino.Logger;
