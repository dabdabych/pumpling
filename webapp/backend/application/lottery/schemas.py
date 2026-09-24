from pydantic import BaseModel, Field
from typing import Any, Dict, List, Optional
from decimal import Decimal
from datetime import datetime


class PricePointResponse(BaseModel):
    timestamp: int
    price: Decimal


class CoinResponse(BaseModel):
    name: str
    symbol: str
    address: str  # Solana token address
    market_cap: Decimal
    current_price: Decimal
    price_history: List[PricePointResponse]
    volume_24h: Decimal
    logo_url: str = None


class LotteryEntryResponse(BaseModel):
    rank: int
    lottery_id: int
    lottery_type: str = "dex"
    coin: CoinResponse
    total_solana_bet: Decimal
    bet_count: int


class LotteryWinnerResultResponse(BaseModel):
    mint: str
    wins: int
    target_lamports: int
    target_sol: float


class LotteryArchiveEntryResponse(BaseModel):
    rank: int
    mint: str
    name: str
    ticker: str
    total_solana_bet: float
    won_sol: Optional[float] = None


class LotteryArchiveItemResponse(BaseModel):
    id: int
    lottery_type: str = "dex"
    status: str
    lottery_pda: Optional[str] = None
    started_at: datetime
    ended_at: datetime
    ended_at_source: str
    close_reason: Optional[str] = None
    initialize_abandoned_at: Optional[datetime] = None
    initialize_abandoned_error: Optional[str] = None
    total_pool_sol: float = 0.0
    entries: List[LotteryArchiveEntryResponse] = Field(default_factory=list)


class LotteryVerificationResponse(BaseModel):
    """Everything an outsider can check a round's draw with.

    The fields are named so that the script in the public repository has nothing
    to guess: the commitment and its preimage, the source of the randomness and
    the fingerprint of the shares algorithm, and the result.
    """
    lottery_id: int
    lottery_type: str
    status: str
    network: str
    program_id: Optional[str] = None
    lottery_account: Optional[str] = None
    vault_account: Optional[str] = None
    admin_account: Optional[str] = None
    #: The weights fingerprint written into the program BEFORE the draw.
    weights_hash_onchain: Optional[str] = None
    #: Exactly the string sha256 was taken over. Anyone can recompute it.
    weights_payload: Optional[str] = None
    weights_hash_recomputed: Optional[str] = None
    weights_match: Optional[bool] = None
    #: Where the randomness came from: VRF or the admin's emergency seed.
    randomness_source: str = "pending"
    randomness_account: Optional[str] = None
    vrf_seed: Optional[str] = None
    vrf_algorithm_hash: Optional[str] = None
    algorithm_source: str = "webapp/backend/application/lottery/vrf_engine.py"
    winner_results: List[LotteryWinnerResultResponse] = Field(default_factory=list)


class LotteryArchiveListResponse(BaseModel):
    lottery_type: str = "dex"
    window_days: int = 7
    items: List[LotteryArchiveItemResponse] = Field(default_factory=list)


class MyCommitCoinResponse(BaseModel):
    """One coin in my round: how much I put in and what became of it."""
    mint: str
    name: str
    ticker: str
    logo_url: Optional[str] = None
    #: How much SOL I put in.
    my_sol: float
    #: How many commits of mine went behind this coin.
    my_commits: int
    #: How much SOL stands behind the coin from everyone together.
    pool_sol: float
    #: How much went into buying it after the draw; None means the draw has not happened.
    drawn_sol: Optional[float] = None
    #: The signatures of my commits: they open on Solscan.
    signatures: List[str] = Field(default_factory=list)


class MyCommitRoundResponse(BaseModel):
    """A round I took part in."""
    lottery_id: int
    lottery_type: str
    status: str
    created_at: Optional[datetime] = None
    end_date: Optional[datetime] = None
    my_sol: float
    pool_sol: float
    #: The wallets I committed from: the bought tokens go to those same wallets.
    wallets: List[str] = Field(default_factory=list)
    coins: List[MyCommitCoinResponse] = Field(default_factory=list)


class MyCommitsResponse(BaseModel):
    total_sol: float
    rounds: List[MyCommitRoundResponse] = Field(default_factory=list)


class ActiveLotterySummaryResponse(BaseModel):
    id: int
    lottery_type: str = "dex"
    status: str
    lottery_pda: Optional[str] = None
    vault_pda: Optional[str] = None
    admin_pubkey: Optional[str] = None
    created_at: Optional[datetime] = None
    end_date: Optional[datetime] = None
    second_phase_started_at: Optional[datetime] = None
    proceeding_purchases_started_at: Optional[datetime] = None
    execution_countdown_seconds: int = 65 * 60
    #: Roughly how long the draw takes: the page runs its countdown from it.
    draw_seconds: int = 12
    #: When the next pool opens. Known once the buying starts: the window plus the pause.
    next_pool_at: Optional[datetime] = None
    max_total: Optional[float] = None
    total_pool_sol: float = 0.0
    winner_results: List[LotteryWinnerResultResponse] = Field(default_factory=list)


class CoinChartPointResponse(BaseModel):
    """A chart point: epoch seconds and the price in dollars."""
    t: int
    p: float


class CoinChartResponse(BaseModel):
    mint: str
    #: false means there is no pool, the source stayed silent, or the coin has not traded yet.
    available: bool = False
    points: List[CoinChartPointResponse] = Field(default_factory=list)
    #: How many minutes the chart covers: a brand new coin may have two.
    minutes: int = 0
    venue: Optional[str] = None
    price_usd: Optional[float] = None
    change_pct: Optional[float] = None


class PurchaseFeedItemResponse(BaseModel):
    """One purchase: it is visible on chain, so we return the signature as is."""
    mint: str
    name: str
    symbol: str
    logo_url: Optional[str] = None
    sol_amount: float
    signature: str
    venue: Optional[str] = None
    at: datetime


class PurchaseFeedCoinResponse(BaseModel):
    mint: str
    name: str
    symbol: str
    logo_url: Optional[str] = None
    target_sol: float
    bought_sol: float
    completed_purchases: int
    planned_purchases: int
    status: str


class PurchaseFeedResponse(BaseModel):
    lottery_id: int
    #: false means the buyer is silent or has not started: the page shows waiting rather than zero.
    available: bool = False
    target_sol: float = 0.0
    bought_sol: float = 0.0
    completed_purchases: int = 0
    planned_purchases: int = 0
    finished: bool = False
    coins: List[PurchaseFeedCoinResponse] = Field(default_factory=list)
    purchases: List[PurchaseFeedItemResponse] = Field(default_factory=list)


class HypeCountdownResponse(BaseModel):
    lottery_type: str
    launch_at: datetime


class LotteryListResponse(BaseModel):
    entries: List[LotteryEntryResponse]
    has_active_lottery: bool = False
    active_lotteries: List[ActiveLotterySummaryResponse] = Field(default_factory=list)
    latest_lotteries: List[ActiveLotterySummaryResponse] = Field(default_factory=list)
    hype_countdowns: List[HypeCountdownResponse] = Field(default_factory=list)


class CreateLotteryRequest(BaseModel):
    name: str
    lottery_type: str = "dex"
    end_date: Optional[datetime] = None
    max_total: Optional[float] = None


class LotteryCycleControlResponse(BaseModel):
    lottery_type: str
    enabled: bool
    stop_requested_at: Optional[datetime] = None
    hype_launch_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None


class LotteryCycleControlsResponse(BaseModel):
    items: List[LotteryCycleControlResponse] = Field(default_factory=list)


class LotteryResponse(BaseModel):
    id: int
    name: str
    lottery_type: str = "dex"
    created_by_user_id: int
    created_at: datetime
    end_date: Optional[datetime]
    second_phase_started_at: Optional[datetime] = None
    proceeding_purchases_started_at: Optional[datetime] = None
    is_offchain_vrf: bool = False
    status: str
    close_reason: Optional[str] = None
    initialize_abandoned_at: Optional[datetime] = None
    initialize_abandoned_error: Optional[str] = None
    max_total: Optional[float] = None
    vrf_seed: Optional[str] = None
    randomness_account: Optional[str] = None


class VrfPreviewResponse(BaseModel):
    weights: Dict[str, int]
    seed_hex: str
    k: int
    wins: Dict[str, int]
    fee_bps: int
    pool: int
    budget_lamports: int
    targets: Dict[str, int]


class PagedLotteryResponse(BaseModel):
    items: List[LotteryResponse]
    total_count: int


class ProblemDetails(BaseModel):
    """RFC 7807 Problem Details for HTTP APIs"""
    type: str = "about:blank"
    title: str
    status: int
    detail: str
    instance: Optional[str] = None


class CreateBetRequest(BaseModel):
    lottery_id: Optional[int] = None
    lottery_type: Optional[str] = None
    meme_coin_address: str
    sol_amount: float
    wallet_address: str
    tx_signature: str


class BetParticipationResponse(BaseModel):
    id: int
    user_id: int
    lottery_id: int
    meme_coin_address: str
    sol_amount: float
    wallet_address: str
    tx_signature: str | None = None
    created_at: datetime


class MintAllowTokenRequest(BaseModel):
    mint_address: str
    lottery_type: Optional[str] = None


class MintAllowTokenResponse(BaseModel):
    is_pumpfun_mint: bool
    has_dex_liquidity: bool = False
    dex_liquidity_pool_count: int = 0
    dex_liquidity_check_unverified: bool = False
    mint_address: str
    network_type: str
    token_name: Optional[str] = None
    token_symbol: Optional[str] = None
    token_image_url: Optional[str] = None
    # The coin's market: these are the numbers a person recognises what they are
    # about to pay for. Any field can be missing, the source is external and does
    # not always answer.
    price_usd: Optional[float] = None
    market_cap_usd: Optional[float] = None
    liquidity_usd: Optional[float] = None
    volume_24h_usd: Optional[float] = None
    price_change_24h: Optional[float] = None
    dex_id: Optional[str] = None
    pair_url: Optional[str] = None


class Phase2AccountsResponse(BaseModel):
    """What the admin browser needs to sign `start_second_phase` itself.

    The request seed is derived here and never in the browser: the same
    derivation already exists in the program and in the worker, and a third
    copy in TypeScript is one more place for the three to disagree.
    """

    lottery_pda: str
    weights_hash: str
    seed_slot: int
    vrf_request: str
    vrf_network_state: str
    vrf_treasury: str
    vrf_program: str
    recent_slothashes: str




class OffchainVrfRequest(BaseModel):
    seed_hex: Optional[str] = None


class RunPurchasesRecipient(BaseModel):
    publickey: str
    amount: float


class RunPurchasesToken(BaseModel):
    mint: str
    totalSol: float
    recipients: List[RunPurchasesRecipient]


class RunPurchasesPayload(BaseModel):
    lotteryId: str
    tokens: List[RunPurchasesToken]


class RunPurchasesResponse(BaseModel):
    lottery_id: int
    payload: RunPurchasesPayload
    offchain_response: Dict[str, Any]


