import logging
import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi import Depends, HTTPException
from presentation.auth.auth_router import router as auth_router, get_current_user, get_user_repository
from application.auth.schemas import ProfileResponse
from domain.auth.repositories.user_repository import UserRepository
from presentation.lottery.lottery_router import router as lottery_router
from presentation.events.events_router import router as events_router
from presentation.rpc.rpc_router import router as rpc_router
from presentation.chat.chat_router import router as chat_router, ws_router as chat_ws_router
from shared.rate_limit import rate_limit_middleware
from create_tables import create_tables
from migrations_runner import run_migrations

app = FastAPI(
    title="DDD FastAPI Application",
    description="A FastAPI application following Domain-Driven Design principles",
    version="1.0.0"
)

cors_origins = [
    origin.strip()
    for origin in os.getenv(
        "CORS_ORIGINS",
        "http://localhost:3200,https://pumpling.xyz,http://pumpling.xyz",
    ).split(",")
    if origin.strip()
]

# Configure CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Rate limiting sits before the routers and after CORS: the browser has to get a
# clear answer rather than an access error. The rules are in shared/rate_limit.py.
app.middleware("http")(rate_limit_middleware)

app.include_router(auth_router)
app.include_router(lottery_router)
app.include_router(events_router)
app.include_router(rpc_router)
app.include_router(chat_router)
app.include_router(chat_ws_router)

def configure_logging() -> None:
    root_logger = logging.getLogger()
    if not root_logger.handlers:
        logging.basicConfig(
            level=logging.INFO,
            format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
        )
    root_logger.setLevel(logging.INFO)

    logging.getLogger("presentation.lottery.lottery_router").setLevel(logging.INFO)
    logging.getLogger("domain.lottery.services.lottery_service").setLevel(logging.INFO)

logger = logging.getLogger(__name__)

@app.on_event("startup")
def ensure_tables_exist() -> None:
    configure_logging()
    create_tables()
    run_migrations()


@app.get("/profile", response_model=ProfileResponse)
async def get_profile(
    current_user_id: int = Depends(get_current_user),
    user_repository: UserRepository = Depends(get_user_repository),
):
    user = await user_repository.find_by_id(current_user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    return ProfileResponse(email=user.email, api_key=None)


@app.get("/ping")
def ping():
    return "pong"


@app.get("/")
def root():
    return {"message": "Welcome to DDD FastAPI Application"}
