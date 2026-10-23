"""Local-only OTel spans and a bounded review queue. No network exporters."""
import hashlib
import json
import logging
import os
import re
from logging.handlers import RotatingFileHandler
from pathlib import Path

from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor, SpanExporter, SpanExportResult

ARTIFACTS = Path(__file__).resolve().parents[1] / "artifacts"


def sink(name: str) -> logging.Logger:
    logger = logging.getLogger("grapevine.local." + name)
    if not logger.handlers:
        ARTIFACTS.mkdir(parents=True, exist_ok=True)
        handler = RotatingFileHandler(ARTIFACTS / f"{name}.jsonl", maxBytes=10_000_000,
                                      backupCount=2, encoding="utf-8")
        handler.setFormatter(logging.Formatter("%(message)s"))
        logger.addHandler(handler)
        logger.setLevel(logging.INFO)
        logger.propagate = False
    return logger


class LocalExporter(SpanExporter):
    def export(self, spans):
        try:
            for span in spans:
                sink("traces").info(span.to_json(indent=None))
            return SpanExportResult.SUCCESS
        except OSError:
            return SpanExportResult.FAILURE

    def shutdown(self):
        pass


provider = TracerProvider(resource=Resource.create({"service.name": "grapevine-llm"}))
provider.add_span_processor(SimpleSpanProcessor(LocalExporter()))
tracer = provider.get_tracer("grapevine-llm")


def scrub(text: str) -> str:
    text = re.sub(r"[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}", "[email]", text)
    text = re.sub(r"\b(?:\+?\d[\d ()-]{7,}\d)\b", "[number]", text)
    text = re.sub(r"(?i)(bearer\s+|api[_-]?key\s*[:=]\s*)\S+", "[credential]", text)
    return text[:8000]


def sample(request, result) -> None:
    """Metadata for all failures and deterministic 5% success sampling; text opt-in."""
    digest = hashlib.sha256(request.model_dump_json().encode()).hexdigest()
    if result.ok and int(digest[:8], 16) % 20:
        return
    item = {"id": digest, "task": request.task, "reviewed": False,
            "ok": result.ok, "code": getattr(result, "code", None),
            "stats": result.stats.model_dump(), "contract_version": result.version}
    if os.environ.get("GRAPEVINE_LLM_SAMPLE_TEXT") == "true":
        item["input"] = scrub(request.model_dump_json())
        item["output"] = scrub(result.model_dump_json())
    try:
        sink("review-queue").info(json.dumps(item))
    except OSError:
        pass
