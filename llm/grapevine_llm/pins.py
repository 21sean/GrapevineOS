"""Refuse mutable model tags unless they resolve to the reviewed local digest."""
import hashlib
import json
import os
from pathlib import Path
from typing import Annotated, Literal

import httpx
from pydantic import Field

from .contracts import Contract
from .settings import local_endpoint

# How the weights are stored, in the words the publisher uses. Recorded with every
# benchmark result: the runtimes serve one base model in different formats, and a
# number means little without knowing which.
Quantization = Annotated[str, Field(min_length=1, max_length=120)]


class ModelPin(Contract):
    name: Annotated[str, Field(min_length=1, max_length=150)]
    digest: Annotated[str, Field(pattern=r"^[a-f0-9]{64}$")]
    quantization: Quantization


class ModelManifest(Contract):
    runtime: Literal["ollama"] = "ollama"
    runtime_version: str
    generation: ModelPin
    judge: ModelPin
    temperature: Literal[0] = 0
    seed: Literal[42] = 42


class VllmModelPin(Contract):
    name: Annotated[str, Field(min_length=1, max_length=150)]
    repository: Annotated[str, Field(pattern=r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", max_length=150)]
    revision: Annotated[str, Field(pattern=r"^[a-f0-9]{40}$")]
    sha256: Annotated[str, Field(pattern=r"^[a-f0-9]{64}$")]
    quantization: Quantization


class VllmManifest(Contract):
    runtime: Literal["vllm"] = "vllm"
    runtime_version: str
    generation: VllmModelPin
    judge: VllmModelPin
    temperature: Literal[0] = 0
    seed: Literal[42] = 42


class TritonManifest(Contract):
    """NVIDIA Triton Inference Server with its vLLM backend, serving vLLM's checkpoint."""

    runtime: Literal["triton"] = "triton"
    # The Triton server version, as its KServe endpoint reports it.
    runtime_version: str
    # The image by tag and by digest: the tag says what it is, the digest pins it.
    container: Annotated[str, Field(pattern=r"^[a-z0-9./-]+:[A-Za-z0-9._-]+@sha256:[a-f0-9]{64}$", max_length=250)]
    backend: Literal["vllm"] = "vllm"
    # The vLLM distribution inside that image.
    backend_version: Annotated[str, Field(min_length=1, max_length=80)]
    # Fingerprint of docker/triton: the engine arguments and the start script.
    repository_sha256: Annotated[str, Field(pattern=r"^[a-f0-9]{64}$")]
    generation: VllmModelPin
    judge: VllmModelPin
    temperature: Literal[0] = 0
    seed: Literal[42] = 42


ROOT = Path(__file__).resolve().parents[2]
PATH = Path(__file__).resolve().parents[1] / "evals/models.json"
VLLM_PATH = PATH.with_name("models.vllm.json")
TRITON_PATH = PATH.with_name("models.triton.json")
TRITON_REPOSITORY = ROOT / "docker/triton"
TRITON_KSERVE_URL = "http://127.0.0.1:9001"


def manifest_path(runtime: str) -> Path:
    return {"vllm": VLLM_PATH, "triton": TRITON_PATH}.get(runtime, PATH)


def manifest() -> ModelManifest:
    return ModelManifest.model_validate_json(PATH.read_text(encoding="utf-8"))


def vllm_manifest() -> VllmManifest:
    return VllmManifest.model_validate_json(VLLM_PATH.read_text(encoding="utf-8"))


def triton_manifest() -> TritonManifest:
    return TritonManifest.model_validate_json(TRITON_PATH.read_text(encoding="utf-8"))


def active_manifest(runtime: str) -> ModelManifest | VllmManifest | TritonManifest:
    return {"vllm": vllm_manifest, "triton": triton_manifest}.get(runtime, manifest)()


def triton_repository_sha256() -> str:
    """One digest over every file Triton is started from, by relative path and content."""
    digest = hashlib.sha256()
    for path in sorted(p for p in TRITON_REPOSITORY.rglob("*") if p.is_file()):
        digest.update(path.relative_to(TRITON_REPOSITORY).as_posix().encode())
        digest.update(b"\0")
        digest.update(path.read_text(encoding="utf-8").encode())
        digest.update(b"\0")
    return digest.hexdigest()


def triton_engine_args(pin: VllmModelPin) -> dict:
    path = TRITON_REPOSITORY / "model_repository" / pin.name / "1" / "model.json"
    return json.loads(path.read_text(encoding="utf-8"))


def verify_triton(base_url: str, num_ctx: int) -> TritonManifest:
    """
    Triton reports its version, the served name and the backend. It reports neither a
    weight digest nor the engine's arguments, so the source path and context length are
    read from the reviewed model repository, which the manifest fingerprints. That
    proves what was reviewed, not what a differently started server is running.
    """
    pins = triton_manifest()
    if triton_repository_sha256() != pins.repository_sha256:
        raise ValueError("Triton model repository differs from model manifest")
    kserve = local_endpoint(os.environ.get("GRAPEVINE_TRITON_KSERVE_URL") or TRITON_KSERVE_URL)
    with httpx.Client(trust_env=False, follow_redirects=False, timeout=5) as client:
        server = client.get(f"{kserve}/v2")
        server.raise_for_status()
        if json.loads(server.content).get("version") != pins.runtime_version:
            raise ValueError("Triton runtime version differs from model manifest")
        response = client.get(f"{local_endpoint(base_url)}/v1/models")
        response.raise_for_status()
        served = {m["id"] for m in json.loads(response.content)["data"]}
        for pin in (pins.generation, pins.judge):
            engine = triton_engine_args(pin)
            if pin.name not in served or not str(engine.get("model", "")).endswith(pin.repository):
                raise ValueError(f"missing or changed local model: {pin.name}")
            if int(engine.get("max_model_len") or 0) < num_ctx:
                raise ValueError(f"Triton max model length is below the requested context: {pin.name}")
            config = client.get(f"{kserve}/v2/models/{pin.name}/config")
            config.raise_for_status()
            if json.loads(config.content).get("backend") != pins.backend:
                raise ValueError(f"Triton serves {pin.name} with another backend")
    return pins


def verify_vllm(base_url: str, num_ctx: int) -> VllmManifest:
    """vLLM reports no weight digest, so this checks version, name, source path, and context."""
    pins = vllm_manifest()
    with httpx.Client(base_url=local_endpoint(base_url), trust_env=False, follow_redirects=False, timeout=5) as client:
        version = client.get("/version")
        version.raise_for_status()
        if json.loads(version.content).get("version") != pins.runtime_version:
            raise ValueError("vLLM runtime version differs from model manifest")
        response = client.get("/v1/models")
        response.raise_for_status()
        served = {m["id"]: m for m in json.loads(response.content)["data"]}
    for pin in (pins.generation, pins.judge):
        model = served.get(pin.name)
        if model is None or not str(model.get("root", "")).endswith(pin.repository):
            raise ValueError(f"missing or changed local model: {pin.name}")
        if int(model.get("max_model_len") or 0) < num_ctx:
            raise ValueError(f"vLLM max model length is below the requested context: {pin.name}")
    return pins


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


def verify_runtime(runtime: str, base_url: str, num_ctx: int) -> ModelManifest | VllmManifest | TritonManifest:
    """Check the running runtime against its reviewed record, whichever runtime it is."""
    if runtime == "vllm":
        return verify_vllm(base_url, num_ctx)
    if runtime == "triton":
        return verify_triton(base_url, num_ctx)
    return verify(base_url)
