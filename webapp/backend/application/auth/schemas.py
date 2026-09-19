from pydantic import BaseModel, EmailStr, Field, field_validator
from typing import List, Optional


class UserRegistrationRequest(BaseModel):
    username: str
    email: EmailStr
    password: str
    nickname: str = Field(min_length=3, max_length=32, pattern=r"^[A-Za-z0-9_]+$")

    @field_validator("nickname")
    @classmethod
    def normalize_nickname(cls, value: str) -> str:
        nickname = value.strip()
        if len(nickname) < 3:
            raise ValueError("Nickname must be at least 3 characters")
        return nickname


class EmailConfirmationRequest(BaseModel):
    token: str


class EmailConfirmationResponse(BaseModel):
    email: str
    message: str


class PasswordResetRequest(BaseModel):
    email: EmailStr


class PasswordResetResponse(BaseModel):
    message: str


class PasswordResetConfirmRequest(BaseModel):
    token: str
    password: str


class UserLoginRequest(BaseModel):
    username: str
    password: str
    remember_me: bool = False

class WalletNonceRequest(BaseModel):
    address: str
    chain: Optional[str] = None


class WalletNonceResponse(BaseModel):
    nonce: str
    domain: str
    uri: str
    chain: str
    issued_at: str
    expiration_time: str


class WalletVerifyRequest(BaseModel):
    address: str
    message: str
    signature: str
    remember_me: bool = False


class UserResponse(BaseModel):
    id: int
    username: str
    nickname: str
    email: str
    role: str


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"


class PagedUserResponse(BaseModel):
    items: List[UserResponse]
    total_count: int


class ProfileResponse(BaseModel):
    email: str
    api_key: Optional[str] = None
