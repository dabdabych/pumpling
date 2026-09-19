export const WSOL_MINT = 'So11111111111111111111111111111111111111112';
export const USDC_MAINNET_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const USDC_DEVNET_MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';

export const BLOCKED_BET_MINT_ERROR = 'USDC and SOL/wSOL cannot be used as lottery bet tokens.';

const BLOCKED_BET_MINTS = new Set([
  WSOL_MINT,
  USDC_MAINNET_MINT,
  USDC_DEVNET_MINT,
]);

export function isBlockedBetMint(mint: string): boolean {
  return BLOCKED_BET_MINTS.has((mint || '').trim());
}
