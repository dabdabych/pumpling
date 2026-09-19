# lottery-contracts
Solana on-chain program

## Network-aware Build/Deploy

The program now uses compile-time network features:
- `devnet` (default)
- `mainnet`

`declare_id!` and Switchboard on-demand program id are selected by feature in:
- `programs/lottery_v_1_0/src/lib.rs`

Before mainnet deployment, replace placeholders:
- `programs/lottery_v_1_0/src/lib.rs` mainnet `declare_id!`
- `Anchor.toml` `[programs.mainnet].lottery_v_1_0`

## Commands

Build devnet:
```bash
npm run build:devnet
```

Build mainnet:
```bash
npm run build:mainnet
```

Deploy devnet:
```bash
npm run deploy:devnet
```

Deploy mainnet:
```bash
npm run deploy:mainnet
```

## Practical Deployment Checklist

1. Confirm active wallet:
```bash
solana address
```
2. Confirm target RPC/cluster:
```bash
solana config get
```
3. Build with correct feature (`devnet`/`mainnet`).
4. Verify `declare_id!` matches target cluster program id.
5. Deploy.
6. Re-export/sync IDL to all consumers (`webapp`, workers, offchain services) after upgrade.
