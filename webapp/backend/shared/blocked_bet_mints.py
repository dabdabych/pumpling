WSOL_MINT = "So11111111111111111111111111111111111111112"
USDC_MAINNET_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
USDC_DEVNET_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"

BLOCKED_BET_MINTS = frozenset({
    WSOL_MINT,
    USDC_MAINNET_MINT,
    USDC_DEVNET_MINT,
})

BLOCKED_BET_MINT_ERROR = "USDC and SOL/wSOL cannot be used as lottery bet tokens"


def is_blocked_bet_mint(mint: str) -> bool:
    return mint.strip() in BLOCKED_BET_MINTS
