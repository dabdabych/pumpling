import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { PublicKey } from '@solana/web3.js';
import { executeLottery } from '../../orchestrator/index';
import { getKeeper } from '../setup';

// Usage:
// node --loader ts-node/esm tests/end-to-end/run_lottery.ts <LOTTERY_JSON>
//
// Example:
// OVERRIDE_N=10 OVERRIDE_SEND_N=10 node --loader ts-node/esm tests/end-to-end/run_lottery.ts test_lottery.json

const args = process.argv.slice(2);
const inputPath = args[0];

if (!inputPath) {
  console.error('Usage: run_lottery.ts <LOTTERY_JSON>');
  process.exit(1);
}

const resolved = path.resolve(inputPath);
if (!fs.existsSync(resolved)) {
  console.error(`File not found: ${resolved}`);
  process.exit(1);
}

const raw = JSON.parse(fs.readFileSync(resolved, 'utf8')) as {
  lotteryId: string;
  tokens: Array<{
    mint: string;
    totalSol: number;
    recipients: Array<{ publickey: string; amount: number }>;
  }>;
};

if (!raw.tokens || raw.tokens.length === 0) {
  console.error('No tokens in input file');
  process.exit(1);
}

// ============================================================================
// LOG FILE — tee console output to logs/run_{lotteryId}.log
// ============================================================================

const logsDir = path.resolve('logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

const logPath = path.join(logsDir, `run_${raw.lotteryId}.log`);
const logStream = fs.createWriteStream(logPath, { flags: 'w' });

const origStdoutWrite = process.stdout.write.bind(process.stdout);
const origStderrWrite = process.stderr.write.bind(process.stderr);

process.stdout.write = (chunk: any, ...args: any[]): boolean => {
  logStream.write(chunk);
  return origStdoutWrite(chunk, ...args);
};

process.stderr.write = (chunk: any, ...args: any[]): boolean => {
  logStream.write(chunk);
  return origStderrWrite(chunk, ...args);
};

// ============================================================================
// RUN
// ============================================================================

const keeper = getKeeper();

console.log(`Keeper: ${keeper.publicKey.toBase58()}`);
console.log(`Lottery: ${raw.lotteryId}`);
console.log(`Tokens: ${raw.tokens.length}`);
console.log(`Log file: ${logPath}`);
console.log();

const tokens = raw.tokens.map((t) => ({
  mint: new PublicKey(t.mint),
  totalSol: t.totalSol,
  recipients: t.recipients.map((r) => ({
    publickey: new PublicKey(r.publickey),
    amount: r.amount,
  })),
}));

async function main() {
  const buyWindowMinutes = process.env.BUY_WINDOW_MINUTES
    ? Number(process.env.BUY_WINDOW_MINUTES)
    : undefined;

  const result = await executeLottery({
    lotteryId: raw.lotteryId,
    tokens,
    keeper,
    buyConcurrency: tokens.length,
    ...(buyWindowMinutes && { buyWindowMinutes }),
  });

  console.log('\n=== RESULT ===');
  console.log(`State file: ${result.stateFilePath}`);
  console.log(`Log file: ${logPath}`);
  console.log(`Tokens bought: ${result.summary.tokensBought}`);
  console.log(`Tokens failed: ${result.summary.tokensFailed}`);
  const sendsDelivered = result.summary.sendsCompleted + result.summary.sendsSatisfied;
  console.log(`Sends delivered: ${sendsDelivered}/${result.summary.sendsTotal} (${result.summary.sendsCompleted} sent + ${result.summary.sendsSatisfied} satisfied)`);
  console.log(`Sends abandoned: ${result.summary.sendsAbandoned}`);
  console.log(`Sends ATA mismatch: ${result.summary.sendsAtaMismatch}`);

  logStream.end();

  const hasFailures = result.summary.tokensFailed > 0 || result.summary.sendsAbandoned > 0;
  process.exit(hasFailures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  logStream.end();
  process.exit(1);
});
