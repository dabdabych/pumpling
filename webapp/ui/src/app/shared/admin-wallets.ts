import { BN } from '@coral-xyz/anchor';
import { Connection, PublicKey } from '@solana/web3.js';
import { Buffer } from 'buffer';

export const DEVNET_ADMIN_WALLETS: readonly string[] = [
  '4TJdM678kP4hS6KMEoh79T3tANUNctHs7bE62MQSz72F',
  'CVsNzQNYgiebatxi2a8tBAvkFSXshg3seXgPR7DAziLq',
  'EGDo2JhA2c3QPDQLKV9Umgfn3srkYvRKmfXPAYasDLeJ',
];

export interface LotteryPdas {
  lottery: PublicKey;
  vault: PublicKey;
  admin: PublicKey;
}

export function isAllowedAdminWallet(walletAddress: string | null | undefined): boolean {
  if (!walletAddress) {
    return false;
  }
  return DEVNET_ADMIN_WALLETS.includes(walletAddress);
}

export function deriveLotteryPdasForAdmin(
  lotteryProgramId: PublicKey,
  lotteryId: number,
  adminPubkey: PublicKey,
): LotteryPdas {
  const encoder = new TextEncoder();
  const lotterySeed = new BN(lotteryId).toArrayLike(Buffer as any, 'le', 8);
  const [lotteryPda] = PublicKey.findProgramAddressSync(
    [encoder.encode('lottery'), adminPubkey.toBytes(), lotterySeed],
    lotteryProgramId
  );
  const [vaultPda] = PublicKey.findProgramAddressSync(
    [encoder.encode('vault'), lotteryPda.toBytes()],
    lotteryProgramId
  );

  return { lottery: lotteryPda, vault: vaultPda, admin: adminPubkey };
}

export async function findExistingLotteryPdas(
  connection: Connection,
  lotteryProgramId: PublicKey,
  lotteryId: number,
  adminWallets: readonly string[] = DEVNET_ADMIN_WALLETS,
): Promise<LotteryPdas | null> {
  if (!Number.isFinite(lotteryId)) {
    return null;
  }

  for (const walletAddress of adminWallets) {
    const adminPubkey = new PublicKey(walletAddress);
    const pdas = deriveLotteryPdasForAdmin(lotteryProgramId, lotteryId, adminPubkey);
    const lotteryAccount = await connection.getAccountInfo(pdas.lottery);
    if (lotteryAccount) {
      return pdas;
    }
  }

  return null;
}
