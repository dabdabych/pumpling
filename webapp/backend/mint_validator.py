# pip install solana solders

from solana.rpc.api import Client
from solders.pubkey import Pubkey

PUMP_PROGRAM_ID = Pubkey.from_string("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P")
PUMP_AMM_PROGRAM_ID = Pubkey.from_string("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA")
WSOL_MINT = Pubkey.from_string("So11111111111111111111111111111111111111112")
TOKEN_PROGRAM_ID = Pubkey.from_string("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")
TOKEN_2022_PROGRAM_ID = Pubkey.from_string("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb")
ASSOCIATED_TOKEN_PROGRAM_ID = Pubkey.from_string("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL")
CANONICAL_POOL_INDEX = 0

# BondingCurve account layout: 8-byte discriminator + 5 x u64 (reserves/supply) + complete flag
_BONDING_CURVE_COMPLETE_OFFSET = 8 + 5 * 8

# quote_mint sits after complete (1) + creator (32) + is_mayhem_mode (1) + 1 unidentified byte.
# pump.fun opened "Custom Pairs" on 2026-09-09: a curve can be denominated in USDC, WBTC or a
# tokenized stock instead of SOL. Such coins cannot be bought with buy_exact_sol_in - the program
# answers UnsupportedQuoteMint (6063) - so the buyer routes them through the aggregator instead.
_BONDING_CURVE_QUOTE_MINT_OFFSET = 83

# Native SOL is written as the System Program (32 zero bytes), not as WSOL.
NATIVE_SOL_QUOTE = Pubkey.from_string("11111111111111111111111111111111")


def is_bonding_curve_complete(raw_data: bytes) -> bool:
    if len(raw_data) <= _BONDING_CURVE_COMPLETE_OFFSET:
        return False
    return bool(raw_data[_BONDING_CURVE_COMPLETE_OFFSET])


def read_bonding_curve_quote_mint(raw_data: bytes) -> Pubkey:
    """
    The asset the curve is denominated in.

    An account too short to hold the field predates Custom Pairs, and back then a curve could
    only be in SOL - so we answer SOL rather than raise. Verified against live 2024 curves
    (150 bytes): they carry the System Program there.
    """
    end = _BONDING_CURVE_QUOTE_MINT_OFFSET + 32
    if len(raw_data) < end:
        return NATIVE_SOL_QUOTE
    return Pubkey.from_bytes(raw_data[_BONDING_CURVE_QUOTE_MINT_OFFSET:end])


def get_pumpfun_curve_info(
    mint_str: str, rpc_url: str = "https://api.mainnet-beta.solana.com"
) -> tuple[bool, bool, Pubkey]:
    """
    Returns (is_pumpfun, graduated, quote_mint):
      is_pumpfun -> the mint was created through pump.fun and has a bonding curve PDA owned by the pump program
      graduated  -> the bonding curve is complete: the token migrated to a DEX and can no
                    longer be bought on the curve (the buyer will route through Jupiter)
      quote_mint -> the asset the curve is denominated in; NATIVE_SOL_QUOTE for ordinary coins
    """
    client = Client(rpc_url)

    try:
        mint = Pubkey.from_string(mint_str)
    except Exception:
        return False, False, NATIVE_SOL_QUOTE

    # PDA = find_program_address(["bonding-curve", mint], PUMP_PROGRAM_ID)
    pda, _bump = Pubkey.find_program_address(
        [b"bonding-curve", bytes(mint)],
        PUMP_PROGRAM_ID
    )

    resp = client.get_account_info(pda)
    info = resp.value
    if info is None:
        return False, False, NATIVE_SOL_QUOTE

    # Require the account owner to be the pump program.
    if info.owner != PUMP_PROGRAM_ID:
        return False, False, NATIVE_SOL_QUOTE

    raw = bytes(info.data)
    return True, is_bonding_curve_complete(raw), read_bonding_curve_quote_mint(raw)


def get_pumpfun_mint_status(mint_str: str, rpc_url: str = "https://api.mainnet-beta.solana.com") -> tuple[bool, bool]:
    """
    Returns (is_pumpfun, graduated). Kept for callers that do not care about the quote asset;
    see get_pumpfun_curve_info when the buying route depends on it.
    """
    is_pumpfun, graduated, _quote = get_pumpfun_curve_info(mint_str, rpc_url=rpc_url)
    return is_pumpfun, graduated


def _canonical_pumpswap_pool(mint: Pubkey) -> Pubkey:
    # Mirrors @pump-fun/pump-swap-sdk canonicalPumpPoolPda(mint) with quote = WSOL.
    pool_authority, _ = Pubkey.find_program_address([b"pool-authority", bytes(mint)], PUMP_PROGRAM_ID)
    pool, _ = Pubkey.find_program_address(
        [
            b"pool",
            CANONICAL_POOL_INDEX.to_bytes(2, "little"),
            bytes(pool_authority),
            bytes(mint),
            bytes(WSOL_MINT),
        ],
        PUMP_AMM_PROGRAM_ID,
    )
    return pool


def _get_token_account_amount(client: Client, token_account: Pubkey) -> int:
    balance = client.get_token_account_balance(token_account).value
    return int(balance.amount)


def has_live_pumpswap_pool(
    mint_str: str,
    rpc_url: str = "https://api.mainnet-beta.solana.com",
    min_quote_lamports: int = 1,
) -> bool:
    """
    True if the graduated token's canonical PumpSwap pool exists and has enough
    depth for the buyer fallback:
      - pool account exists and is owned by PumpSwap AMM
      - base token vault has tokens to sell to the keeper
      - quote WSOL vault has at least min_quote_lamports as a conservative depth guard

    The final source of truth remains the buyer's SDK-built transaction and
    on-chain slippage checks; this preflight rejects obviously dead/tiny pools.
    """
    client = Client(rpc_url)

    try:
        mint = Pubkey.from_string(mint_str)
    except Exception:
        return False

    pool = _canonical_pumpswap_pool(mint)
    pool_info = client.get_account_info(pool).value
    if pool_info is None or pool_info.owner != PUMP_AMM_PROGRAM_ID:
        return False

    mint_info = client.get_account_info(mint).value
    if mint_info is None:
        return False
    base_token_program = mint_info.owner

    # Pool token vaults are ATAs owned by the pool PDA.
    base_vault, _ = Pubkey.find_program_address(
        [bytes(pool), bytes(base_token_program), bytes(mint)],
        ASSOCIATED_TOKEN_PROGRAM_ID,
    )
    quote_vault, _ = Pubkey.find_program_address(
        [bytes(pool), bytes(TOKEN_PROGRAM_ID), bytes(WSOL_MINT)],
        ASSOCIATED_TOKEN_PROGRAM_ID,
    )
    try:
        base_amount = _get_token_account_amount(client, base_vault)
        quote_amount = _get_token_account_amount(client, quote_vault)
        return base_amount > 0 and quote_amount >= max(1, int(min_quote_lamports or 1))
    except Exception:
        return False


def is_pumpfun_mint(mint_str: str, rpc_url: str = "https://api.mainnet-beta.solana.com") -> bool:
    """
    True  -> the mint was created through pump.fun and has a bonding curve PDA owned by the pump program
    False -> the mint is not from pump.fun or is invalid
    """
    is_pumpfun, _graduated = get_pumpfun_mint_status(mint_str, rpc_url=rpc_url)
    return is_pumpfun


if __name__ == "__main__":
    # Example
    mint = "DysNZiMXB5k4hxuz4cnyRA1MdTJyYb9qMytmArXiWoRs"  # Replace with the target mint.
    print(get_pumpfun_mint_status(mint))


class MintCheckUnavailable(RuntimeError):
    """The node did not answer, so nothing is known about this address."""


# A mint account as the token programs store it: 4 + 32 + 8 + 1 + 1 + 4 + 32.
# Token-2022 appends extensions after that, so this is a floor, not a size.
# Taken from the layout in @solana/spl-token, which is vendored under
# offchain/, rather than from memory.
_MINT_ACCOUNT_MIN_SIZE = 82
#: mint_authority_option(4) + mint_authority(32) + supply(8) + decimals(1)
_MINT_IS_INITIALIZED_OFFSET = 45


def is_spl_mint(mint_str: str, rpc_url: str = "https://api.mainnet-beta.solana.com") -> bool:
    """Whether this address is an initialised SPL mint. One RPC call.

    This is the cheapest question that can be asked about a coin, and it used
    to be asked last or not at all. A pubkey anyone can generate offline went
    through a DexScreener lookup, a bonding curve probe and a metadata fetch
    that includes a Helius DAS call, and DAS costs ten credits against one for
    an ordinary RPC call. Eleven credits to learn that a random 32 bytes is not
    a coin.

    So it is asked first now. An address that is not a mint cannot be committed
    to, cannot be bought and has no metadata, and saying so costs one credit.

    The checks mirror `unpackMint` in @solana/spl-token: the account exists, it
    belongs to one of the two token programs, it is long enough to be a mint,
    and its `is_initialized` flag is set. Both programs are accepted because
    Token-2022 coins do turn up on pump.fun.

    A malformed address is False. An RPC that cannot be reached raises
    `MintCheckUnavailable` instead of answering False, because the two mean
    opposite things: this check also guards `place_bet`, and a node having a bad
    minute must not turn a real coin into a rejected commit.
    """
    try:
        mint = Pubkey.from_string((mint_str or "").strip())
    except Exception:
        return False

    try:
        info = Client(rpc_url).get_account_info(mint).value
    except Exception as exc:
        raise MintCheckUnavailable(str(exc)) from exc
    if info is None:
        return False
    if info.owner not in (TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID):
        return False
    data = bytes(info.data or b"")
    if len(data) < _MINT_ACCOUNT_MIN_SIZE:
        return False
    return bool(data[_MINT_IS_INITIALIZED_OFFSET])
