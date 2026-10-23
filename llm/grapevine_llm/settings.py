from ipaddress import ip_address
from urllib.parse import urlsplit

from pydantic import Field, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


def local_endpoint(value: str) -> str:
    url = urlsplit(value)
    if url.scheme != "http" or url.username or url.password or url.query or url.fragment:
        raise ValueError("local inference requires an explicit http loopback endpoint")
    host = url.hostname or ""
    if host != "localhost" and not ip_address(host).is_loopback:
        raise ValueError("only loopback inference endpoints are permitted")
    if url.path not in ("", "/"):
        raise ValueError("inference endpoint cannot include a path")
    return value.rstrip("/")


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="GRAPEVINE_LLM_", extra="forbid")
    base_url: str = "http://127.0.0.1:11434"
    model: str = "qwen3.8:27b"
    max_attempts: int = Field(default=3, ge=1, le=5)
    timeout_seconds: float = Field(default=120, gt=0, le=300)
    max_bytes: int = Field(default=1_000_000, ge=1024, le=4_000_000)
    num_ctx: int = Field(default=16384, ge=2048, le=100_000)
    seed: int = 42

    @model_validator(mode="after")
    def offline(self):
        local_endpoint(self.base_url)
        if "cloud" in self.model.lower() or "/" in self.model:
            raise ValueError("cloud models are disabled")
        return self
