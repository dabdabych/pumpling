from typing import Any

from sqlalchemy import func
from sqlalchemy.orm import Session

from application.lottery.vrf_engine import VrfEngine
from infrastructure.database.models.bet_participation_model import BetParticipationModel
from shared.bet_confirmation import active_bet_condition


def collect_lottery_weights(db: Session, lottery_id: int) -> dict[str, int]:
    rows = db.query(
        BetParticipationModel.meme_coin_address,
        func.sum(BetParticipationModel.sol_amount).label("total_sol"),
    ).filter(
        BetParticipationModel.lottery_id == lottery_id,
        active_bet_condition(BetParticipationModel),
    ).group_by(
        BetParticipationModel.meme_coin_address
    ).all()

    weights: dict[str, int] = {}
    for mint, total_sol in rows:
        if total_sol is None:
            continue
        lamports = int(round(float(total_sol) * 1_000_000_000))
        if lamports > 0:
            weights[str(mint)] = lamports
    return weights


def normalize_seed_hex(seed_hex: str | None) -> str | None:
    if not seed_hex:
        return None
    normalized = str(seed_hex).strip().lower()
    if normalized.startswith("0x"):
        normalized = normalized[2:]
    if len(normalized) != 64:
        raise ValueError("vrf_seed must be a 64-char hex string")
    bytes.fromhex(normalized)
    return normalized


def run_vrf_for_lottery(
    weights: dict[str, int],
    lottery: Any,
    *,
    fee_bps: int = 300,
) -> dict[str, object]:
    normalized_seed_hex = normalize_seed_hex(getattr(lottery, "vrf_seed", None))
    if not normalized_seed_hex:
        raise ValueError("Lottery vrf_seed is missing")
    return VrfEngine.run_with_seed(weights, bytes.fromhex(normalized_seed_hex), fee_bps=fee_bps)


def build_run_purchases_payload(
    db: Session,
    lottery: Any,
    *,
    fee_bps: int = 300,
) -> dict[str, object]:
    lottery_id = getattr(lottery, "id", None)
    if lottery_id is None:
        raise ValueError("Lottery id is missing")

    weights = collect_lottery_weights(db, int(lottery_id))
    vrf_result = run_vrf_for_lottery(weights, lottery, fee_bps=fee_bps)
    wins: dict[str, int] = vrf_result.get("wins", {}) if isinstance(vrf_result, dict) else {}
    targets: dict[str, int] = vrf_result.get("targets", {}) if isinstance(vrf_result, dict) else {}

    bets = db.query(BetParticipationModel).filter(
        BetParticipationModel.lottery_id == lottery_id,
        active_bet_condition(BetParticipationModel),
    ).all()

    tokens: list[dict[str, object]] = []
    for mint, win_count in wins.items():
        if int(win_count or 0) <= 0:
            continue

        target_lamports = int(targets.get(mint, 0) or 0)
        total_sol = round(target_lamports / 1_000_000_000, 8)
        if total_sol <= 0:
            continue

        per_wallet: dict[str, float] = {}
        for bet in bets:
            if str(bet.meme_coin_address) != mint:
                continue
            amount = float(bet.sol_amount)
            if amount <= 0:
                continue
            per_wallet[bet.wallet_address] = per_wallet.get(bet.wallet_address, 0.0) + amount

        recipients = [
            {
                "publickey": wallet,
                "amount": round(amount, 8),
            }
            for wallet, amount in sorted(per_wallet.items(), key=lambda item: item[1], reverse=True)
            if amount > 0
        ]
        if not recipients:
            continue

        tokens.append({
            "mint": mint,
            "totalSol": total_sol,
            "recipients": recipients,
        })

    return {
        "lotteryId": str(lottery_id),
        "tokens": tokens,
    }
