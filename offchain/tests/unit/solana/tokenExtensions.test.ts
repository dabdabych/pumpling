// tests/unit/solana/tokenExtensions.test.ts
// The "spend SOL or not" gate. A mistake either way is expensive: let an
// undeliverable coin through and we trade refundable SOL for an unrefundable
// token; block a normal one wrongly and the round loses that coin.

import { PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, AccountState } from "@solana/spl-token";

const mockGetAccountInfo = jest.fn();
jest.mock("../../../solana/connection", () => ({
    connection: { getAccountInfo: (...a: unknown[]) => mockGetAccountInfo(...a) },
}));

const mockGetMint = jest.fn();
const mockExtensionTypes = jest.fn();
const mockTransferFee = jest.fn();
const mockTransferHook = jest.fn();
const mockDefaultState = jest.fn();
const mockPermanentDelegate = jest.fn();
jest.mock("@solana/spl-token", () => ({
    ...jest.requireActual("@solana/spl-token"),
    getMint: (...a: unknown[]) => mockGetMint(...a),
    getExtensionTypes: (...a: unknown[]) => mockExtensionTypes(...a),
    getTransferFeeConfig: (...a: unknown[]) => mockTransferFee(...a),
    getTransferHook: (...a: unknown[]) => mockTransferHook(...a),
    getDefaultAccountState: (...a: unknown[]) => mockDefaultState(...a),
    getPermanentDelegate: (...a: unknown[]) => mockPermanentDelegate(...a),
}));

import { inspectMint, clearMintInspectionCache } from "../../../solana/tokenExtensions";

const MINT = new PublicKey("So11111111111111111111111111111111111111112");

function withExtensions(types: number[], owner = TOKEN_2022_PROGRAM_ID): void {
    mockGetAccountInfo.mockResolvedValue({ owner, data: Buffer.alloc(200) });
    mockGetMint.mockResolvedValue({ decimals: 6, tlvData: Buffer.alloc(types.length ? 8 : 0) });
    mockExtensionTypes.mockReturnValue(types);
}

beforeEach(() => {
    jest.clearAllMocks();
    clearMintInspectionCache();
    mockTransferFee.mockReturnValue(null);
    mockTransferHook.mockReturnValue(null);
    mockDefaultState.mockReturnValue(null);
    mockPermanentDelegate.mockReturnValue(null);
});

describe("blocking extensions", () => {
    it("NonTransferable blocks", async () => {
        withExtensions([9]);
        const r = await inspectMint(MINT);
        expect(r.blockers).toHaveLength(1);
        expect(r.blockers[0]).toContain("NonTransferable");
    });

    it("DefaultAccountState blocks ONLY when Frozen", async () => {
        withExtensions([6]);
        mockDefaultState.mockReturnValue({ state: AccountState.Frozen });
        expect((await inspectMint(MINT)).blockers).toHaveLength(1);

        clearMintInspectionCache();
        mockDefaultState.mockReturnValue({ state: AccountState.Initialized });
        const ok = await inspectMint(MINT);
        expect(ok.blockers).toHaveLength(0);
        expect(ok.warnings.join()).toContain("not Frozen");
    });
});

describe("the transfer hook", () => {
    it("a hook with a real program needs the special instruction", async () => {
        withExtensions([14]);
        mockTransferHook.mockReturnValue({ programId: new PublicKey("11111111111111111111111111111112") });
        const r = await inspectMint(MINT);
        expect(r.hasTransferHook).toBe(true);
        expect(r.blockers).toHaveLength(0);
    });

    it("a hook with an empty program changes nothing", async () => {
        // The extension is there but the program is zero, so the transfer is ordinary
        withExtensions([14]);
        mockTransferHook.mockReturnValue({ programId: PublicKey.default });
        expect((await inspectMint(MINT)).hasTransferHook).toBe(false);
    });
});

describe("the transfer fee", () => {
    it("does not block, but lands in the warnings and in the config", async () => {
        withExtensions([1]);
        mockTransferFee.mockReturnValue({
            newerTransferFee: { transferFeeBasisPoints: 300 },
        });
        const r = await inspectMint(MINT);
        expect(r.blockers).toHaveLength(0);
        expect(r.transferFeeConfig).not.toBeNull();
        expect(r.warnings.join()).toContain("300");
    });
});

describe("harmless against unknown", () => {
    it("metadata and display stay quiet", async () => {
        // This is exactly the set pump.fun gives its own coins
        withExtensions([18, 19, 25]);
        const r = await inspectMint(MINT);
        expect(r.blockers).toHaveLength(0);
        expect(r.warnings).toHaveLength(0);
    });

    it("an unfamiliar number lands in the warnings instead of passing in silence", async () => {
        withExtensions([250]);
        const r = await inspectMint(MINT);
        expect(r.warnings.join()).toContain("unknown");
    });

    it("Pausable and PermanentDelegate are flagged but do not block", async () => {
        withExtensions([12, 26]);
        mockPermanentDelegate.mockReturnValue({ delegate: PublicKey.default });
        const r = await inspectMint(MINT);
        expect(r.blockers).toHaveLength(0);
        expect(r.warnings).toHaveLength(2);
    });
});

describe("an ordinary SPL token", () => {
    it("extensions are not read at all", async () => {
        withExtensions([], TOKEN_PROGRAM_ID);
        const r = await inspectMint(MINT);
        expect(r.isToken2022).toBe(false);
        expect(r.extensions).toHaveLength(0);
        expect(r.blockers).toHaveLength(0);
        expect(mockExtensionTypes).not.toHaveBeenCalled();
    });
});
