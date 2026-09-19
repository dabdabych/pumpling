from solders.pubkey import Pubkey

from mint_validator import (
    ASSOCIATED_TOKEN_PROGRAM_ID,
    _BONDING_CURVE_COMPLETE_OFFSET,
    _canonical_pumpswap_pool,
    has_live_pumpswap_pool,
    is_bonding_curve_complete,
    PUMP_AMM_PROGRAM_ID,
    TOKEN_PROGRAM_ID,
    WSOL_MINT,
)


def _curve_bytes(complete: int) -> bytes:
    # 8-byte discriminator + 5 x u64 + complete flag (+ trailing fields)
    return bytes(_BONDING_CURVE_COMPLETE_OFFSET) + bytes([complete]) + bytes(32)


def test_active_curve_is_not_complete():
    assert is_bonding_curve_complete(_curve_bytes(0)) is False


def test_graduated_curve_is_complete():
    assert is_bonding_curve_complete(_curve_bytes(1)) is True


def test_short_account_data_is_fail_safe():
    assert is_bonding_curve_complete(b"") is False
    assert is_bonding_curve_complete(bytes(_BONDING_CURVE_COMPLETE_OFFSET)) is False


def test_canonical_pumpswap_pool_matches_onchain():
    # Ground truth: HYBRIDS (BmU6x…Dpump) graduated pool on mainnet is 7TZx…SqKU.
    # Locks the pool-authority + pool PDA seeds against accidental changes.
    mint = Pubkey.from_string("BmU6xeGzmReT1ap2oCwYXmin82WUH51LPfvoVBeDpump")
    pool = _canonical_pumpswap_pool(mint)
    assert str(pool) == "7TZxStGBDqTTGTkk2oqEyTZn4vws1NvFukH3btm8SqKU"


def test_live_pumpswap_pool_requires_base_and_min_quote_liquidity(monkeypatch):
    mint = Pubkey.from_string("BmU6xeGzmReT1ap2oCwYXmin82WUH51LPfvoVBeDpump")
    pool = _canonical_pumpswap_pool(mint)
    base_vault, _ = Pubkey.find_program_address(
        [bytes(pool), bytes(TOKEN_PROGRAM_ID), bytes(mint)],
        ASSOCIATED_TOKEN_PROGRAM_ID,
    )
    quote_vault, _ = Pubkey.find_program_address(
        [bytes(pool), bytes(TOKEN_PROGRAM_ID), bytes(WSOL_MINT)],
        ASSOCIATED_TOKEN_PROGRAM_ID,
    )

    class _Account:
        def __init__(self, owner):
            self.owner = owner

    class _AccountResp:
        def __init__(self, value):
            self.value = value

    class _Balance:
        def __init__(self, amount: int):
            self.amount = str(amount)

    class _BalanceResp:
        def __init__(self, amount: int):
            self.value = _Balance(amount)

    class _Client:
        quote_amount = 2_000_000_000

        def __init__(self, _rpc_url: str):
            pass

        def get_account_info(self, pubkey):
            if pubkey == pool:
                return _AccountResp(_Account(PUMP_AMM_PROGRAM_ID))
            if pubkey == mint:
                return _AccountResp(_Account(TOKEN_PROGRAM_ID))
            return _AccountResp(None)

        def get_token_account_balance(self, pubkey):
            if pubkey == base_vault:
                return _BalanceResp(1)
            if pubkey == quote_vault:
                return _BalanceResp(self.quote_amount)
            raise AssertionError(f"unexpected token account {pubkey}")

    monkeypatch.setattr("mint_validator.Client", _Client)

    assert has_live_pumpswap_pool(str(mint), min_quote_lamports=1_000_000_000) is True

    _Client.quote_amount = 500_000_000
    assert has_live_pumpswap_pool(str(mint), min_quote_lamports=1_000_000_000) is False
