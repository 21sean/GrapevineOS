"""Refuse mutable model tags unless they resolve to the reviewed local digest."""
import json
from pathlib import Path
from typing import Annotated, Literal

import httpx
from pydantic import Field

from .contracts import Contract
from .settings import local_endpoint


class ModelPin(Contract):
    name: Annotated[str, Field(min_length=1, max_length=150)]
    digest: Annotated[str, Field(pattern=r"^[a-f0-9]{64}$")]


class ModelManifest(Contract):
    runtime: Literal["ollama"] = "ollama"
    runtime_version: str
    generation: ModelPin
    judge: ModelPin
    temperature: Literal[0] = 0
    seed: Literal[42] = 42


PATH = Path(__file__).resolve().parents[1] / "evals/models.json"


def manifest() -> ModelManifest:
    return ModelManifest.model_validate_json(PATH.read_text(encoding="utf-8"))


def verify(base_url: str) -> ModelManifest:
    pins = manifest()
    with httpx.Client(base_url=local_endpoint(base_url), trust_env=False, follow_redirects=False, timeout=5) as client:
        version = client.get("/api/version")
        version.raise_for_status()
        if json.loads(version.content).get("version") != pins.runtime_version:
            raise ValueError("Ollama runtime version differs from model manifest")
        response = client.get("/api/tags")
        response.raise_for_status()
        installed = {m["name"]: m["digest"] for m in json.loads(response.content)["models"]}
    for pin in (pins.generation, pins.judge):
        if installed.get(pin.name) != pin.digest:
            raise ValueError(f"missing or changed local model: {pin.name}")
    return pins
