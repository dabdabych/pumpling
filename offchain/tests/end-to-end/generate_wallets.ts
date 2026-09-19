import fs from 'node:fs';
import path from 'node:path';
import { Keypair } from '@solana/web3.js';

// Usage:
// node --loader ts-node/esm scripts/generate_wallets.ts <COUNT> <OUT_FILE>

const args = process.argv.slice(2);
const count = args[0] ? Number(args[0]) : 10;
const outFile = args[1] || 'wallets.json';

if (!Number.isFinite(count) || count <= 0) {
  throw new Error('Bad count');
}

const wallets = Array.from({ length: count }, () => {
  const kp = Keypair.generate();
  return {
    publicKey: kp.publicKey.toBase58(),
    secretKey: Array.from(kp.secretKey)
  };
});

const outPath = path.resolve(outFile);
fs.writeFileSync(outPath, JSON.stringify({ count, wallets }, null, 2));

console.log(`Generated ${count} wallets`);
console.log(`Saved to ${outPath}`);
