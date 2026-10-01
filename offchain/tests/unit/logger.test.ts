// tests/unit/logger.test.ts
//
// No API key reaches a log line. The RPC endpoints carry the key in the query
// string, and an error from a call to one can quote the URL whole; in
// production every line is scrubbed on its way to stdout.

import { createLogger, redactSecrets } from "../../logger";

const KEY = "helius-test-key-0000";
const ENDPOINT = `https://mainnet.helius-rpc.com/?api-key=${KEY}`;

describe("redactSecrets", () => {
    it("takes the key and leaves the address and the other parameters", () => {
        expect(redactSecrets(`${ENDPOINT}&commitment=confirmed, then`)).toBe(
            "https://mainnet.helius-rpc.com/?api-key=***&commitment=confirmed, then"
        );
    });

    it("leaves a word that only ends in token alone", () => {
        expect(redactSecrets("mytoken=keep")).toBe("mytoken=keep");
    });
});

describe("the production logger", () => {
    const env = process.env.NODE_ENV;
    afterEach(() => {
        process.env.NODE_ENV = env;
    });

    function capture() {
        process.env.NODE_ENV = "production";
        const lines: string[] = [];
        const log = createLogger({ write: (line: string) => lines.push(line) });
        return { log, lines };
    }

    it("scrubs the message, a field and a serialized error, and every line still parses", () => {
        const { log, lines } = capture();

        log.info({ rpc: ENDPOINT }, `start ${ENDPOINT}`);
        log.error({ err: new Error(`request to ${ENDPOINT} failed`) }, "rpc failed");
        log.warn({ error: `fetch "${ENDPOINT}" failed` }, "quoted");

        expect(lines).toHaveLength(3);
        expect(lines.join("")).not.toContain(KEY);
        const parsed = lines.map((line) => JSON.parse(line));
        expect(parsed[0].rpc).toBe("https://mainnet.helius-rpc.com/?api-key=***");
        expect(parsed[1].err.message).toBe("request to https://mainnet.helius-rpc.com/?api-key=*** failed");
        expect(parsed[2].error).toBe('fetch "https://mainnet.helius-rpc.com/?api-key=***" failed');
    });

    it("a child logger goes through the same line", () => {
        const { log, lines } = capture();

        log.child({ endpoint: ENDPOINT }).info("child");

        expect(lines.join("")).not.toContain(KEY);
    });
});
