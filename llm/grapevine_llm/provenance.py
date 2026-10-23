import hashlib
import platform
from pathlib import Path

from .contracts import Contract

ROOT = Path(__file__).resolve().parents[2]


class Provenance(Contract):
    source_sha256: str
    dependencies_sha256: str
    models_sha256: str
    python_version: str
    num_ctx: int
    max_attempts: int


def digest(paths: list[Path]) -> str:
    h = hashlib.sha256()
    for path in sorted(paths):
        h.update(path.relative_to(ROOT).as_posix().encode())
        h.update(b"\0")
        h.update(path.read_text(encoding="utf-8").encode())
        h.update(b"\0")
    return h.hexdigest()


def capture(num_ctx: int, max_attempts: int) -> Provenance:
    sources = [*ROOT.glob("server/src/**/*.ts"), *ROOT.glob("llm/grapevine_llm/*.py"),
               ROOT / "server/scripts/llm-quality.ts", ROOT / "server/scripts/eval-network.mjs"]
    return Provenance(source_sha256=digest(sources),
                      dependencies_sha256=digest([ROOT / "package-lock.json", ROOT / "llm/uv.lock"]),
                      models_sha256=digest([ROOT / "llm/evals/models.json"]),
                      python_version=platform.python_version(), num_ctx=num_ctx, max_attempts=max_attempts)
