from shared.blocked_bet_mints import (
    BLOCKED_BET_MINTS,
    USDC_DEVNET_MINT,
    USDC_MAINNET_MINT,
    WSOL_MINT,
    is_blocked_bet_mint,
)


def test_blocks_usdc_and_wsol_mints() -> None:
    assert BLOCKED_BET_MINTS == {
        WSOL_MINT,
        USDC_MAINNET_MINT,
        USDC_DEVNET_MINT,
    }
    assert is_blocked_bet_mint(WSOL_MINT)
    assert is_blocked_bet_mint(USDC_MAINNET_MINT)
    assert is_blocked_bet_mint(USDC_DEVNET_MINT)


def test_allows_other_mints() -> None:
    assert not is_blocked_bet_mint("DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263")
