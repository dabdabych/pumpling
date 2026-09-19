import fs from 'node:fs';
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  LAMPORTS_PER_SOL
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  createCloseAccountInstruction
} from '@solana/spl-token';
import {
  JUPITER_QUOTE_URL,
  JUPITER_SWAP_URL,
  SLIPPAGE_BPS,
  JUPITER_MAX_ACCOUNTS,
  JUPITER_ONLY_DIRECT_ROUTES,
} from '../../solana/config';
import { connection as conn } from '../../solana/connection';
import { getKeeper } from '../setup';

// Usage:
// node --loader ts-node/esm scripts/cleanup_wallets.ts <WALLETS_JSON> <FUNDER_PUBKEY> <RECEIVER_PUBKEY>

const args = process.argv.slice(2);
const walletsPath = args[0] || 'wallets.json';
const funderPubkeyStr = args[1];
const receiverPubkeyStr = args[2];

if (!funderPubkeyStr || !receiverPubkeyStr) {
  throw new Error('FUNDER_PUBKEY and RECEIVER_PUBKEY are required');
}

const funderPubkey = new PublicKey(funderPubkeyStr);
const receiverPubkey = new PublicKey(receiverPubkeyStr);
const funderKp = getKeeper();

const FUND_LAMPORTS = Math.floor(0.01 * LAMPORTS_PER_SOL);
const RESERVE_LAMPORTS = 5_000; // tx fee only — account goes to 0

const walletsData = JSON.parse(fs.readFileSync(walletsPath, 'utf8')) as {
  wallets: Array<{ publicKey: string; secretKey: number[] }>;
};

if (!walletsData.wallets || walletsData.wallets.length === 0) {
  throw new Error('No wallets in file');
}

async function sendLamports(from: Keypair, to: PublicKey, lamports: number): Promise<string> {
  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: from.publicKey,
      toPubkey: to,
      lamports
    })
  );
  const sig = await conn.sendTransaction(tx, [from], {
    skipPreflight: false,
    maxRetries: 3
  });
  const latest = await conn.getLatestBlockhash('confirmed');
  await conn.confirmTransaction({ signature: sig, ...latest }, 'confirmed');
  return sig;
}

async function jupiterSwapTokenToSol(
  user: Keypair,
  inputMint: PublicKey,
  amountRaw: string
): Promise<string> {
  const quoteUrl = new URL(JUPITER_QUOTE_URL);
  quoteUrl.searchParams.set('inputMint', inputMint.toString());
  quoteUrl.searchParams.set('outputMint', 'So11111111111111111111111111111111111111112');
  quoteUrl.searchParams.set('amount', amountRaw);
  quoteUrl.searchParams.set('slippageBps', String(SLIPPAGE_BPS));
  quoteUrl.searchParams.set('restrictIntermediateTokens', 'true');
  quoteUrl.searchParams.set('maxAccounts', String(JUPITER_MAX_ACCOUNTS));
  if (JUPITER_ONLY_DIRECT_ROUTES) {
    quoteUrl.searchParams.set('onlyDirectRoutes', 'true');
  }

  const quoteRes = await fetch(quoteUrl.toString());
  if (!quoteRes.ok) {
    throw new Error(`Jupiter quote failed: ${quoteRes.status} ${await quoteRes.text()}`);
  }
  const quoteJson = await quoteRes.json();

  const swapRes = await fetch(JUPITER_SWAP_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      quoteResponse: quoteJson,
      userPublicKey: user.publicKey.toString(),
      wrapAndUnwrapSol: true,
      prioritizationFeeLamports: 0
    })
  });
  if (!swapRes.ok) {
    throw new Error(`Jupiter swap build failed: ${swapRes.status} ${await swapRes.text()}`);
  }
  const swapJson = await swapRes.json() as { swapTransaction?: string };

  const swapTxB64: string | undefined = swapJson.swapTransaction;
  if (!swapTxB64) throw new Error('Jupiter swap response missing swapTransaction');

  const txBuf = Buffer.from(swapTxB64, 'base64');
  const vtx = (await import('@solana/web3.js')).VersionedTransaction.deserialize(txBuf);
  vtx.sign([user]);

  const sig = await conn.sendTransaction(vtx, {
    skipPreflight: false,
    maxRetries: 3
  });
  const latest = await conn.getLatestBlockhash('confirmed');
  await conn.confirmTransaction({ signature: sig, ...latest }, 'confirmed');
  return sig;
}

async function closeTokenAccounts(
  owner: Keypair,
  accounts: Array<{ pubkey: PublicKey; programId: PublicKey }>
): Promise<void> {
  for (const acc of accounts) {
    const tx = new Transaction().add(
      createCloseAccountInstruction(
        acc.pubkey,
        owner.publicKey,
        owner.publicKey,
        [],
        acc.programId
      )
    );
    try {
      const sig = await conn.sendTransaction(tx, [owner], {
        skipPreflight: false,
        maxRetries: 3
      });
      const latest = await conn.getLatestBlockhash('confirmed');
      await conn.confirmTransaction({ signature: sig, ...latest }, 'confirmed');
      console.log(`  closed ATA ${acc.pubkey.toBase58().slice(0, 8)}... sig=${sig.slice(0, 16)}...`);
    } catch (e: any) {
      console.log(`  close ATA failed: ${e?.message || e}`);
    }
  }
}

async function cleanupWallet(kp: Keypair): Promise<void> {
  // Fund wallet for cleanup (skip if already has enough)
  const currentBalance = await conn.getBalance(kp.publicKey, 'confirmed');
  if (currentBalance < FUND_LAMPORTS) {
    try {
      await sendLamports(funderKp, kp.publicKey, FUND_LAMPORTS);
    } catch (e: any) {
      console.log(`  funding failed: ${e?.message || e}`);
      return;
    }
  } else {
    console.log(`  already funded (${currentBalance} lamports)`);
  }

  // Sell all token balances (Token + Token-2022)
  const tokenAccounts = [];
  const parsed = await conn.getParsedTokenAccountsByOwner(kp.publicKey, {
    programId: TOKEN_PROGRAM_ID
  });
  tokenAccounts.push(...parsed.value.map((v) => ({ ...v, programId: TOKEN_PROGRAM_ID })));

  const parsed2022 = await conn.getParsedTokenAccountsByOwner(kp.publicKey, {
    programId: TOKEN_2022_PROGRAM_ID
  });
  tokenAccounts.push(...parsed2022.value.map((v) => ({ ...v, programId: TOKEN_2022_PROGRAM_ID })));

  for (const acc of tokenAccounts) {
    const info: any = acc.account.data.parsed.info;
    const mint = new PublicKey(info.mint);
    const amountRaw = info.tokenAmount.amount as string;
    if (amountRaw === '0') continue;

    try {
      const sig = await jupiterSwapTokenToSol(kp, mint, amountRaw);
      console.log(`  swapped ${mint.toBase58().slice(0, 8)}... sig=${sig.slice(0, 16)}...`);
    } catch (e: any) {
      console.log(`  swap failed for ${mint.toBase58().slice(0, 8)}... ${e?.message || e}`);
    }
  }

  // Close empty token accounts
  const closeTargets: Array<{ pubkey: PublicKey; programId: PublicKey }> = [];
  for (const acc of tokenAccounts) {
    const info: any = acc.account.data.parsed.info;
    const amountRaw = info.tokenAmount.amount as string;
    if (amountRaw !== '0') continue;
    closeTargets.push({ pubkey: acc.pubkey, programId: acc.programId });
  }
  if (closeTargets.length > 0) {
    await closeTokenAccounts(kp, closeTargets);
  }

  // Send SOL back to master (leave reserve)
  const balance = await conn.getBalance(kp.publicKey, 'confirmed');
  const sendLamportsAmt = Math.max(0, balance - RESERVE_LAMPORTS);
  if (sendLamportsAmt <= 0) {
    console.log('  balance too low, skip transfer');
    return;
  }
  try {
    const sig = await sendLamports(kp, receiverPubkey, sendLamportsAmt);
    console.log(`  sent ${sendLamportsAmt} lamports back, sig=${sig.slice(0, 16)}...`);
  } catch (e: any) {
    console.log(`  send back failed: ${e?.message || e}`);
  }
}

console.log(`Funder: ${funderPubkey.toBase58()}`);
console.log(`Receiver: ${receiverPubkey.toBase58()}`);
console.log(`Wallets: ${walletsData.wallets.length}`);

async function main() {
  for (const w of walletsData.wallets) {
    const kp = Keypair.fromSecretKey(Uint8Array.from(w.secretKey));
    console.log(`\n== Cleanup ${kp.publicKey.toBase58().slice(0, 8)}...`);
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await cleanupWallet(kp);
        break;
      } catch (e: any) {
        const msg = e?.message || String(e);
        if (msg.includes('429') && attempt < 2) {
          console.log(`  429 — waiting 10s before retry...`);
          await new Promise(r => setTimeout(r, 10_000));
        } else {
          console.log(`  cleanup error: ${msg}`);
          break;
        }
      }
    }
    // Throttle to avoid 429 on free tier Helius
    await new Promise(r => setTimeout(r, 3000));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
