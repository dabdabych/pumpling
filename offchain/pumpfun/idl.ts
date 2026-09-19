// src/pumpfun/idl.ts
// A minimal IDL for pump.fun — only buy() and BondingCurve
//
// Source: https://github.com/pump-fun/pump-public-docs/tree/main/idl
// The full IDL has 40 instructions (create, sell, migrate and others)
export const PUMPFUN_IDL = {
    version: "0.1.0",
    name: "pump_fun",
    instructions: [
        {
            name: "buy",
            accounts: [
                { name: "global", isMut: false, isSigner: false },
                { name: "feeRecipient", isMut: true, isSigner: false },
                { name: "mint", isMut: false, isSigner: false },
                { name: "bondingCurve", isMut: true, isSigner: false },
                { name: "associatedBondingCurve", isMut: true, isSigner: false },
                { name: "associatedUser", isMut: true, isSigner: false },
                { name: "user", isMut: true, isSigner: true },
                { name: "systemProgram", isMut: false, isSigner: false },
                { name: "tokenProgram", isMut: false, isSigner: false },
                { name: "creatorVault", isMut: true, isSigner: false },
                { name: "eventAuthority", isMut: false, isSigner: false },
                { name: "program", isMut: false, isSigner: false },
                { name: "globalVolumeAccumulator", isMut: false, isSigner: false },
                { name: "userVolumeAccumulator", isMut: true, isSigner: false },
                { name: "feeConfig", isMut: false, isSigner: false },
                { name: "feeProgram", isMut: false, isSigner: false },
                { name: "bondingCurveV2", isMut: false, isSigner: false },
                { name: "buybackFeeRecipient", isMut: true, isSigner: false },
            ],
            args: [
                { name: "amount", type: "u64" },
                { name: "maxSolCost", type: "u64" },
                { name: "trackVolume", type: { defined: "OptionBool" } },
            ],
        },
    ],
    types: [
        {
            name: "OptionBool",
            type: {
                kind: "struct",
                fields: [
                    { name: "value", type: "bool" },
                ],
            },
        },
    ],
    accounts: [
        {
            name: "BondingCurve",
            type: {
                kind: "struct",
                fields: [
                    { name: "virtualTokenReserves", type: "u64" },
                    { name: "virtualSolReserves", type: "u64" },
                    { name: "realTokenReserves", type: "u64" },
                    { name: "realSolReserves", type: "u64" },
                    { name: "tokenTotalSupply", type: "u64" },
                    { name: "complete", type: "bool" },
                    { name: "creator", type: "publicKey" },
                    { name: "isMayhemMode", type: "bool" },
                ],
            },
        },
    ],
};

export type PumpfunIDL = typeof PUMPFUN_IDL;
