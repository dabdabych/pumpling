import fs from 'node:fs';
import path from 'node:path';

// Usage:
// node --loader ts-node/esm scripts/generate_lottery_input.ts \
//   <WALLETS_JSON> <INPUT_SOL> <MINTS_CSV> <WALLET_COUNT> <OUT_FILE>
//
// Example:
// node --loader ts-node/esm scripts/generate_lottery_input.ts \
//   wallets.json 0.1 "So11111111111111111111111111111111111111112,EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" 10 test_lottery.json

const args = process.argv.slice(2);
const walletsPath = args[0] || 'wallets.json';
const inputSol = args[1] ? Number(args[1]) : 0.1;
const mintsCsv = args[2] || '';
const walletCount = args[3] ? Number(args[3]) : undefined;
const outFile = args[4] || 'test_lottery.json';

if (!Number.isFinite(inputSol) || inputSol <= 0) {
  throw new Error('Bad inputSol');
}
if (!mintsCsv.trim()) {
  throw new Error('MINTS_CSV is required');
}

const mints = mintsCsv.split(',').map((s) => s.trim()).filter(Boolean);
if (mints.length === 0) {
  throw new Error('No mints provided');
}

const raw = JSON.parse(fs.readFileSync(walletsPath, 'utf8')) as {
  wallets: Array<{ publicKey: string }>;
};
if (!raw.wallets || raw.wallets.length === 0) {
  throw new Error('No wallets in file');
}

const useCount = walletCount ?? raw.wallets.length;
if (!Number.isFinite(useCount) || useCount < 1 || useCount > 40) {
  throw new Error('WALLET_COUNT must be between 1 and 40');
}

const wallets = raw.wallets.slice(0, useCount);

// Unique mints provided
const mintSet = Array.from(new Set(mints));
const mintCount = mintSet.length;

// Distribute inputSol across mints with minimum 2% each and near-even random jitter
const minShare = 0.02;
const variance = 0.3; // +/-30% around equal share
if (mintCount * minShare > 1) {
  throw new Error('Too many mints for 2% minimum share');
}

const baseShare = 1 / mintCount;
let shares = mintSet.map(() => {
  const jitter = (Math.random() - 0.5) * 2 * variance;
  return baseShare * (1 + jitter);
});

const sumShares = shares.reduce((s, v) => s + v, 0);
shares = shares.map((v) => v / sumShares);

// Enforce minimum share by redistributing deficit
let deficit = 0;
for (let i = 0; i < shares.length; i++) {
  if (shares[i] < minShare) {
    deficit += minShare - shares[i];
    shares[i] = minShare;
  }
}
if (deficit > 0) {
  const adjustable = shares.reduce((s, v) => s + (v > minShare ? v : 0), 0);
  if (adjustable <= 0) {
    throw new Error('Unable to satisfy minShare with current mint count');
  }
  for (let i = 0; i < shares.length; i++) {
    if (shares[i] > minShare) {
      shares[i] -= deficit * (shares[i] / adjustable);
    }
  }
}

// Normalize tiny drift
const drift = shares.reduce((s, v) => s + v, 0);
shares[shares.length - 1] += 1 - drift;

const mintTotals = mintSet.map((mint, i) => {
  const totalSol = shares[i] * inputSol;
  const rounded = Math.round(totalSol * 1e9) / 1e9;
  return { mint, totalSol: rounded };
});

// Assign 1..4 wallets per mint
const recipientsByMint = new Map<string, Array<{ publickey: string; amount: number }>>();
let walletIndex = 0;

for (const mint of mintSet) {
  const remaining = wallets.length - walletIndex;
  const walletCountForMint = Math.min(1 + Math.floor(Math.random() * 4), remaining);
  if (walletCountForMint === 0) {
    throw new Error('Not enough wallets to assign at least 1 per mint');
  }
  const recipients: Array<{ publickey: string; amount: number }> = [];
  for (let i = 0; i < walletCountForMint; i++) {
    const w = wallets[walletIndex++];
    const amount = Math.round((1 + Math.random() * 9) * 1e9) / 1e9;
    recipients.push({ publickey: w.publicKey, amount });
  }
  recipientsByMint.set(mint, recipients);
}

const tokens = mintTotals.map((m) => ({
  mint: m.mint,
  totalSol: m.totalSol,
  recipients: recipientsByMint.get(m.mint) || []
}));

const output = {
  lotteryId: `test_${Date.now()}`,
  tokens
};

const outPath = path.resolve(outFile);
fs.writeFileSync(outPath, JSON.stringify(output, null, 2));

console.log(`Wallets used: ${wallets.length}`);
console.log(`Unique mints: ${mintCount}`);
console.log(`Saved to ${outPath}`);
