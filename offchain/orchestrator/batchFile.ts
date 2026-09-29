// orchestrator/batchFile.ts
// Reading a batch's state file.

/**
 * One line of code with two callers that must not import each other: recovery
 * (`resume`) needs it to see what was already bought, and the refund accounting
 * (`refundLedger`, through `orchestrator`) needs it to find the signatures. A
 * file that is missing or half-written is not an error here — the caller
 * decides what to do without it.
 */

import * as fs from "fs";

import { BatchState } from "../scheduler/types";

export function readBatchFile(filePath?: string): BatchState | null {
    if (!filePath) {
        return null;
    }
    try {
        return JSON.parse(fs.readFileSync(filePath, "utf-8")) as BatchState;
    } catch {
        return null;
    }
}
