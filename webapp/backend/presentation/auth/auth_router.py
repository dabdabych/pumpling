import base64
import logging
import secrets
import threading
import time
from datetime import datetime, timedelta, timezone
from urllib.parse import urlparse

import base58
import nacl.exceptions
from nacl.signing import VerifyKey
from fastapi import APIRouter, HTTPException, Depends, Query
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from sqlalchemy.orm import Session

from application.auth.schemas import (
    UserRegistrationRequest,
    EmailConfirmationRequest,
    EmailConfirmationResponse,
    ResendConfirmationRequest,
    ResendConfirmationResponse,
    PasswordResetRequest,
    PasswordResetResponse,
    PasswordResetConfirmRequest,
    UserLoginRequest,
    UserResponse,
    TokenResponse,
    PagedUserResponse,
    WalletNonceRequest,
    WalletNonceResponse,
    WalletVerifyRequest,
)
from domain.auth.entities.user import User, UserRole
from domain.auth.repositories.user_repository import UserRepository
from domain.auth.services.auth_service import AuthService, EmailNotVerifiedError
from infrastructure.auth.database_user_repository import DatabaseUserRepository
from infrastructure.auth.smtp_registration_email_sender import SmtpRegistrationEmailSender
from infrastructure.database.database import get_db
from infrastructure.database.models.wallet_auth_nonce_model import WalletAuthNonceModel
from shared.admin_wallets import is_configured_admin_pubkey
from shared.jwt_handler import JWTHandler
from shared.wallet_owner import LINKED_VIA_SIGNATURE, link_wallet
from shared.settings import get_settings

router = APIRouter(prefix="/auth", tags=["auth"])
logger = logging.getLogger(__name__)
security = HTTPBearer()

jwt_handler = JWTHandler(get_settings().jwt_secret_key)
REMEMBER_ME_TOKEN_TTL = timedelta(days=30)


#: How long before the confirmation email can be asked for again, and how many
#: times in an hour. Sixty seconds is the usual figure: long enough that a
#: double click or a reload sends one email, short enough that somebody waiting
#: on a message is not stuck. Three an hour covers "it did not arrive, try the
#: other address" without turning into a way to mail somebody repeatedly at our
#: expense — every send costs a Brevo credit and lands in a real inbox.
CONFIRMATION_RESEND_COOLDOWN_SECONDS = 60
CONFIRMATION_RESEND_MAX_PER_HOUR = 3


class _ResendCooldown:
    """When each address last asked, whether or not it has an account.

    Keyed by the address that was typed, not by a user row, and recorded even
    when nothing is sent. That is deliberate: if only real accounts were
    counted, the 429 would itself answer "is this address registered", which is
    the question the neutral response exists to avoid.

    In process memory, like the chat and RPC limiters, because the backend runs
    as a single uvicorn process. A restart forgets the cooldowns; deploys are
    ours and rare, and the per-address ceiling is not the only thing standing
    here — `shared/rate_limit.py` limits this path per client address as well.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._asked: dict[str, list[float]] = {}

    def check(self, email: str) -> None:
        """Raises `_ResendTooSoon` when this address has to wait."""
        key = (email or "").strip().lower()
        now = time.monotonic()
        with self._lock:
            self._sweep(now)
            recent = self._asked.setdefault(key, [])
            if recent and now - recent[-1] < CONFIRMATION_RESEND_COOLDOWN_SECONDS:
                raise _ResendTooSoon(
                    int(CONFIRMATION_RESEND_COOLDOWN_SECONDS - (now - recent[-1])) + 1
                )
            if len(recent) >= CONFIRMATION_RESEND_MAX_PER_HOUR:
                raise _ResendTooSoon(int(3600 - (now - recent[0])) + 1)
            recent.append(now)

    def _sweep(self, now: float) -> None:
        for key in list(self._asked):
            kept = [at for at in self._asked[key] if now - at < 3600]
            if kept:
                self._asked[key] = kept
            else:
                del self._asked[key]

    def reset_for_tests(self) -> None:
        with self._lock:
            self._asked.clear()


class _ResendTooSoon(Exception):
    def __init__(self, retry_after_seconds: int):
        self.retry_after_seconds = max(1, retry_after_seconds)
        super().__init__(f"retry after {self.retry_after_seconds}s")


resend_cooldown = _ResendCooldown()


def get_user_repository(db: Session = Depends(get_db)) -> UserRepository:
    return DatabaseUserRepository(db)


def get_auth_service(user_repository: UserRepository = Depends(get_user_repository)) -> AuthService:
    settings = get_settings()
    return AuthService(user_repository, SmtpRegistrationEmailSender(settings), settings.public_app_base_url)


async def get_current_user(credentials: HTTPAuthorizationCredentials = Depends(security)) -> int:
    user_id = jwt_handler.verify_token(credentials.credentials)
    if user_id is None:
        raise HTTPException(status_code=401, detail="Invalid token")
    return user_id


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _parse_wallet_message(message: str) -> dict[str, str]:
    lines = [line.strip() for line in message.splitlines() if line.strip()]
    if len(lines) < 7:
        raise ValueError("Invalid wallet sign-in message format")

    first_line = lines[0]
    fields: dict[str, str] = {}
    for line in lines[1:]:
        if ":" not in line:
            continue
        key, value = line.split(":", 1)
        fields[key.strip().lower()] = value.strip()

    parsed = {
        "statement": first_line,
        "address": fields.get("address", ""),
        "nonce": fields.get("nonce", ""),
        "issued_at": fields.get("issued at", ""),
        "expiration_time": fields.get("expiration time", ""),
        "uri": fields.get("uri", ""),
        "chain": fields.get("chain", ""),
    }

    if not all(parsed.values()):
        raise ValueError("Wallet sign-in message is missing required fields")

    return parsed


def _validate_wallet_address(address: str) -> bytes:
    try:
        decoded = base58.b58decode(address)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Invalid wallet address format") from exc

    if len(decoded) != 32:
        raise HTTPException(status_code=400, detail="Invalid wallet address length")

    return decoded


def _decode_signature(signature: str) -> bytes:
    try:
        return base64.b64decode(signature)
    except Exception as exc:
        raise HTTPException(status_code=400, detail="Invalid signature encoding") from exc


@router.post("/register", response_model=UserResponse)
async def register(request: UserRegistrationRequest, auth_service: AuthService = Depends(get_auth_service)):
    try:
        user = await auth_service.register(request.username, request.email, request.password, request.nickname)
        return UserResponse(id=user.id, username=user.username, nickname=user.nickname, email=user.email, role=user.role.value)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as exc:
        logger.exception(
            "Failed to register user because the confirmation email could not be sent (email=%s)",
            request.email,
        )
        raise HTTPException(
            status_code=503,
            detail="We could not send the confirmation email. Please try again later.",
        ) from exc


@router.post("/confirm-email", response_model=EmailConfirmationResponse)
async def confirm_email(request: EmailConfirmationRequest, auth_service: AuthService = Depends(get_auth_service)):
    try:
        user = await auth_service.confirm_email(request.token)
        return EmailConfirmationResponse(email=user.email, message="Email confirmed")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/resend-confirmation", response_model=ResendConfirmationResponse)
async def resend_confirmation(
    request: ResendConfirmationRequest,
    auth_service: AuthService = Depends(get_auth_service),
):
    """Send the confirmation email again.

    Before this existed, an account whose first email never arrived had nowhere
    to go. Signing in answered "your email is not confirmed"; the password
    reset does nothing for an unconfirmed account and says so in the same
    neutral sentence it always uses. The only way through was to register again
    with the same address, which happens to work, and nothing told anyone that.

    The answer is the same whether or not the address has an account, and the
    same whether or not anything was sent. A different answer would turn this
    into a way to find out who has registered.
    """
    try:
        resend_cooldown.check(request.email)
    except _ResendTooSoon as too_soon:
        raise HTTPException(
            status_code=429,
            detail="We just sent one. Check your inbox, then try again in a moment.",
            headers={"Retry-After": str(too_soon.retry_after_seconds)},
        ) from too_soon

    try:
        await auth_service.resend_confirmation(request.email)
    except Exception:
        # A provider having a bad minute is ours to see, not the caller's to
        # read a hint from: the answer below does not change.
        logger.exception("Failed to resend the confirmation email")

    return ResendConfirmationResponse(
        message="If that address needs confirming, we have sent the link again."
    )


@router.post("/request-password-reset", response_model=PasswordResetResponse)
async def request_password_reset(
    request: PasswordResetRequest,
    auth_service: AuthService = Depends(get_auth_service),
):
    try:
        await auth_service.request_password_reset(request.email)
        return PasswordResetResponse(
            message="If an active account exists for this email, a password reset link has been sent."
        )
    except Exception as exc:
        logger.exception("Failed to send password reset email (email=%s)", request.email)
        raise HTTPException(
            status_code=503,
            detail="We could not send the password reset email. Please try again later.",
        ) from exc


@router.post("/reset-password", response_model=PasswordResetResponse)
async def reset_password(
    request: PasswordResetConfirmRequest,
    auth_service: AuthService = Depends(get_auth_service),
):
    try:
        await auth_service.reset_password(request.token, request.password)
        return PasswordResetResponse(message="Password has been updated")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/login", response_model=TokenResponse)
async def login(request: UserLoginRequest, auth_service: AuthService = Depends(get_auth_service)):
    try:
        user = await auth_service.authenticate(request.username, request.password)
    except EmailNotVerifiedError as e:
        raise HTTPException(status_code=403, detail=str(e))
    if not user:
        raise HTTPException(status_code=401, detail="Invalid credentials")

    expires_delta = REMEMBER_ME_TOKEN_TTL if request.remember_me else None
    access_token = jwt_handler.create_access_token(user.id, user.role.value, expires_delta=expires_delta)
    return TokenResponse(access_token=access_token)


@router.post("/wallet/nonce", response_model=WalletNonceResponse)
async def create_wallet_nonce(
    request: WalletNonceRequest,
    db: Session = Depends(get_db),
):
    settings = get_settings()
    address = request.address.strip()
    _validate_wallet_address(address)

    chain = (request.chain or settings.wallet_auth_chain).strip()
    if chain != settings.wallet_auth_chain:
        raise HTTPException(status_code=400, detail="Unexpected chain")

    nonce = secrets.token_urlsafe(24)
    now = _utc_now()
    expiration = now + timedelta(seconds=max(settings.wallet_auth_nonce_ttl_seconds, 60))

    db.query(WalletAuthNonceModel).filter(
        WalletAuthNonceModel.wallet_address == address,
        WalletAuthNonceModel.used_at.is_(None),
    ).delete(synchronize_session=False)

    db.add(
        WalletAuthNonceModel(
            nonce=nonce,
            wallet_address=address,
            expires_at=expiration,
            used_at=None,
            created_at=now,
        )
    )
    db.commit()

    return WalletNonceResponse(
        nonce=nonce,
        domain=settings.wallet_auth_domain,
        uri=settings.wallet_auth_uri,
        chain=chain,
        issued_at=now.isoformat(),
        expiration_time=expiration.isoformat(),
    )


@router.post("/wallet/verify", response_model=TokenResponse)
async def verify_wallet_signature(
    request: WalletVerifyRequest,
    user_repository: UserRepository = Depends(get_user_repository),
    db: Session = Depends(get_db),
):
    settings = get_settings()
    address = request.address.strip()
    address_bytes = _validate_wallet_address(address)

    try:
        parsed_message = _parse_wallet_message(request.message)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    expected_statement = f"{settings.wallet_auth_domain} wants you to sign in with your wallet"
    if parsed_message["statement"] != expected_statement:
        raise HTTPException(status_code=400, detail="Unexpected message domain")

    if parsed_message["address"] != address:
        raise HTTPException(status_code=400, detail="Address mismatch")

    if parsed_message["chain"] != settings.wallet_auth_chain:
        raise HTTPException(status_code=400, detail="Unexpected chain")

    expected_uri_host = urlparse(settings.wallet_auth_uri).netloc
    message_uri_host = urlparse(parsed_message["uri"]).netloc
    if message_uri_host != expected_uri_host:
        raise HTTPException(status_code=400, detail="Unexpected URI")

    try:
        issued_at = datetime.fromisoformat(parsed_message["issued_at"].replace("Z", "+00:00"))
        expiration_time = datetime.fromisoformat(parsed_message["expiration_time"].replace("Z", "+00:00"))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Invalid issuedAt/expirationTime") from exc

    now = _utc_now()
    if issued_at > now + timedelta(minutes=2):
        raise HTTPException(status_code=400, detail="issuedAt is in the future")
    if expiration_time <= now:
        raise HTTPException(status_code=400, detail="Challenge expired")

    nonce_row = db.query(WalletAuthNonceModel).filter(
        WalletAuthNonceModel.nonce == parsed_message["nonce"],
        WalletAuthNonceModel.wallet_address == address,
    ).first()

    if not nonce_row or nonce_row.used_at is not None:
        raise HTTPException(status_code=400, detail="Nonce is invalid or already used")
    if nonce_row.expires_at.replace(tzinfo=timezone.utc) <= now:
        raise HTTPException(status_code=400, detail="Nonce expired")

    signature_bytes = _decode_signature(request.signature)
    if len(signature_bytes) != 64:
        raise HTTPException(status_code=400, detail="Invalid signature size")

    try:
        verify_key = VerifyKey(address_bytes)
        verify_key.verify(request.message.encode("utf-8"), signature_bytes)
    except (nacl.exceptions.BadSignatureError, ValueError) as exc:
        raise HTTPException(status_code=401, detail="Invalid signature") from exc

    nonce_row.used_at = now
    db.commit()

    wallet_email = f"wallet_{address.lower()}@wallet.local"
    wallet_role = UserRole.ADMIN if is_configured_admin_pubkey(address, settings) else UserRole.CUSTOMER
    user = await user_repository.find_by_email(wallet_email)
    if not user:
        temp_password = secrets.token_urlsafe(24)
        user = User(
            id=None,
            username=wallet_email,
            email=wallet_email,
            hashed_password=AuthService.hash_password(temp_password),
            is_active=True,
            role=wallet_role,
            nickname=f"wallet_{address[:24]}",
        )
        user = await user_repository.save(user)
    elif user.role != wallet_role:
        user.role = wallet_role
        user = await user_repository.save(user)

    # A signature proves ownership of the key, so the wallet is attached to this
    # account and commits recorded before sign-in move to it.
    try:
        link_wallet(db, user_id=int(user.id), address=address, linked_via=LINKED_VIA_SIGNATURE)
    except Exception:
        logger.exception("failed to link wallet %s to user %s", address, user.id)
        db.rollback()

    expires_delta = REMEMBER_ME_TOKEN_TTL if request.remember_me else None
    access_token = jwt_handler.create_access_token(user.id, user.role.value, expires_delta=expires_delta)
    return TokenResponse(access_token=access_token)


@router.get("/me", response_model=UserResponse)
async def get_current_user_info(current_user_id: int = Depends(get_current_user), user_repository: UserRepository = Depends(get_user_repository)):
    user = await user_repository.find_by_id(current_user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    return UserResponse(id=user.id, username=user.username, nickname=user.nickname, email=user.email, role=user.role.value)


@router.get("/users", response_model=PagedUserResponse)
async def get_all_users(
    page_index: int = Query(0, ge=0),
    page_size: int = Query(10, ge=1, le=100),
    user_repository: UserRepository = Depends(get_user_repository),
    current_user_id: int = Depends(get_current_user)
):
    skip = page_index * page_size
    users, total_count = await user_repository.find_all(skip=skip, limit=page_size)
    user_responses = [
        UserResponse(id=user.id, username=user.username, nickname=user.nickname, email=user.email, role=user.role.value)
        for user in users
    ]
    return PagedUserResponse(items=user_responses, total_count=total_count)
