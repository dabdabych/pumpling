"""
Script to create database tables
"""
from infrastructure.database.database import engine, Base
from infrastructure.database.models.user_model import UserModel  # Keep model imports so tables are registered.
from infrastructure.database.models.lottery_model import LotteryModel  # Keep model imports so tables are registered.
from infrastructure.database.models.bet_participation_model import BetParticipationModel  # Keep model imports so tables are registered.
from infrastructure.database.models.smart_contract_event_model import SmartContractEventModel  # Keep model imports so tables are registered.
from infrastructure.database.models.allowed_mint_model import AllowedMintModel  # Keep model imports so tables are registered.
from infrastructure.database.models.wallet_auth_nonce_model import WalletAuthNonceModel  # Keep model imports so tables are registered.
from infrastructure.database.models.token_metadata_model import TokenMetadataModel  # Keep model imports so tables are registered.
from infrastructure.database.models.lottery_cycle_control_model import LotteryCycleControlModel  # Keep model imports so tables are registered.
from infrastructure.database.models.user_wallet_model import UserWalletModel  # Keep model imports so tables are registered.
from infrastructure.database.models.chat_model import ChatAttachmentModel, ChatMessageModel, ChatModel  # Keep model imports so tables are registered.


def create_tables():
    """Create all database tables"""
    print("Creating database tables...")
    Base.metadata.create_all(bind=engine)
    print("Database tables created successfully!")


if __name__ == "__main__":
    create_tables()
