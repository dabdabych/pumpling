import jwt
from datetime import datetime, timedelta
from typing import Optional


class JWTHandler:
    def __init__(self, secret_key: str, algorithm: str = "HS256"):
        self.secret_key = secret_key
        self.algorithm = algorithm

    def create_access_token(self, user_id: int, role: str, expires_delta: Optional[timedelta] = None) -> str:
        to_encode = {"user_id": user_id, "role": role}

        if expires_delta:
            expire = datetime.utcnow() + expires_delta
        else:
            expire = datetime.utcnow() + timedelta(hours=24)

        to_encode.update({"exp": expire})
        encoded_jwt = jwt.encode(to_encode, self.secret_key, algorithm=self.algorithm)
        return encoded_jwt

    def verify_token(self, token: str) -> Optional[int]:
        try:
            payload = jwt.decode(token, self.secret_key, algorithms=[self.algorithm])
            user_id: int = payload.get("user_id")
            if user_id is None:
                return None
            return user_id
        except jwt.PyJWTError:
            return None