"""Authoritative contracts and the local, fail-closed inference boundary."""
import os
from . import network as network

# Set policy before importing any optional evaluator or tracing SDK.
for key, value in {
    "DEEPEVAL_TELEMETRY_OPT_OUT": "1", "ERROR_REPORTING": "NO",
    "RAGAS_DO_NOT_TRACK": "true", "LANGCHAIN_TRACING_V2": "false",
    "LANGSMITH_TRACING": "false", "HF_HUB_OFFLINE": "1",
    "HF_DATASETS_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1",
    "OTEL_TRACES_EXPORTER": "none", "OTEL_METRICS_EXPORTER": "none",
    "OTEL_LOGS_EXPORTER": "none",
}.items():
    os.environ[key] = value
