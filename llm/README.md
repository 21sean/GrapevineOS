# Structured inference and offline quality gates

Pydantic v2 is the contract source for model inputs, outputs, tool arguments,
wire envelopes, and eval artifacts. The Node application calls one bounded Python
worker through `server/src/llm/gateway.ts`. Ollama generates with the exported JSON
Schema; Instructor and Pydantic validate the complete response before it reaches
application code. Generated Zod schemas check the Node boundary again.

Defaults are three total attempts, one 120-second deadline, temperature 0, seed
42, and 16,384 context tokens. Repairs receive bounded validation errors. Failure
returns a typed error with no partial output. Agent text is released after the
whole answer validates, so token-by-token display is intentionally unavailable.
Schema conformance does not establish factual accuracy; evidence checks and evals
cover that separately.

## Install and run

Use the repository's Node version, Python 3.12, uv 0.6.9, and the local Ollama
runtime/model in [evals/models.json](evals/models.json). Commands run at repo root:

```sh
npm ci
uv sync --directory llm --frozen --group eval
uv run --directory llm --no-sync python -m grapevine_llm.export --check
uv run --directory llm --no-sync pytest -q
node --import ./server/scripts/eval-network.mjs --import tsx ./server/scripts/llm-quality.ts
```

For live generation and local judges, set `GRAPEVINE_LLM_BASE_URL` to the local
Ollama endpoint (PowerShell: `$env:GRAPEVINE_LLM_BASE_URL='http://127.0.0.1:11435'`)
and append `--live` to the last command. CI verifies both the runtime version and
model digests before inference. No model is downloaded automatically. `OLLAMA_NO_CLOUD=1`
should be set when starting Ollama. The separate Windows runtime uses port 11435;
the ordinary installation can continue on 11434.

The application reads the Ollama URL and model from its settings, with `OLLAMA_URL`
as the URL fallback. Configure both chat and extraction to use Ollama. Hosted
subscription CLI generation fails closed. `GRAPEVINE_LLM_PYTHON` can override the
worker interpreter; otherwise it uses `llm/.venv`. Pydantic Settings also accepts
`GRAPEVINE_LLM_MAX_ATTEMPTS` (1–5), `GRAPEVINE_LLM_TIMEOUT_SECONDS` (up to 300), and
`GRAPEVINE_LLM_NUM_CTX`; the Node call deadline remains 125 seconds.

## Add or change a schema

1. Define a strict `Contract` in `grapevine_llm/contracts.py`; register outputs in
   `OUTPUTS` or tool arguments in `TOOL_ARGS`. Add the task to `Request.task` when
   adding a new output. Use bounded fields and Literals. Put cross-field and known-ID
   checks in validators, with trusted `Context` supplied by application code.
2. Add successful, malformed, coercion, and business-rule tests. Add a golden case.
3. Bump `VERSION` and the request/result version Literals, then run
   `uv run --directory llm --no-sync python -m grapevine_llm.export`.
4. Commit `contracts/llm/<version>/` and the generated TypeScript file. Preserve
   older version directories. CI forbids any change to a published schema, which
   is stricter and simpler than trying to infer every possible breaking change.

All exported schemas are checked with jsonschema Draft 2020-12. Non-Python
consumers can use these language-independent contracts; contextual business
validators still run in Python. The small Zod exporter rejects unsupported schema
constructs instead of silently dropping them.

## Cases, scores, and baselines

[evals/golden.jsonl](evals/golden.jsonl) contains 30 synthetic, locally stored cases:
normal extraction/ratings/tools, malformed output, coercion, invalid IDs, repair
exhaustion, injection, and empty evidence. Fifteen also run on the real model.
Copy a case, give it a unique matching request ID, and add exact field checks.
`responses` drives deterministic replay, not the live run. Set `live: true` for
model cases and add an explicit `rubric` only for subjective criteria.

Deterministic failures stop the run before judging. DeepEval applies local typed
judges with explicit score anchors. RAG answers additionally receive groundedness
and relevance rubrics. Ragas computes ID precision/recall over the versioned
retrieval snapshots. These snapshots do **not** benchmark the live Supabase
retriever. The starter judge shares the generation model; it is not an independent
measure of correctness. Follow [calibration.md](calibration.md) for human review.

```sh
# Check the current run against both the checked-in and PR-base baselines.
uv run --directory llm --no-sync python -m grapevine_llm.checks quality --report artifacts/live.json --base-ref origin/main
# After inspecting every changed output and score, intentionally replace it.
uv run --directory llm --no-sync python -m grapevine_llm.maintenance baseline artifacts/live.json --reviewed
npx prettier --write llm/evals/baseline.json
```

Run the live suite again after changing source, locks, or model pins. The baseline
command rejects stale fingerprints. Commit the reviewed baseline with the change;
editing it cannot hide a regression against the PR base. Gates require all cases,
all required judges ≥0.75, first-pass schema success ≥95%, no hard failures, and no
per-case score or first-pass regression. Timing is recorded, not used as a flaky
hardware-dependent merge threshold. Artifacts include per-case outputs, attempts,
scores, timings, source/lock/model fingerprints, runtime, seed, and revision.

## Offline operation, tracing, and CI

Preload npm/uv caches, the Python runtime, and Ollama models on the same OS and
architecture before transfer into an air-gapped environment. Then install with:

```sh
uv sync --directory llm --frozen --offline --group eval
npm ci --offline --ignore-scripts
node server/scripts/patch-deepeval.mjs
```

Python blocks non-loopback socket/DNS access. The Node eval preload blocks remote
TCP, DNS lookup, and fetch; SDK telemetry/uploads are disabled. Use an egress-denied
host for physical air-gap enforcement. Evaluators, datasets, and traces need no
external service. GitHub checkout/status/artifact transport is the online CI
control plane; the same commands work without GitHub inside an air gap. Existing
application data/map integrations retain their own network requirements.

The `LLM quality` workflow runs on every PR and main push. Its `contracts` job
checks schemas, fuzz tests, replay, and the real Node/Python boundary. Its
`model-quality` job uses a pre-provisioned Windows runner labeled `grapevine-llm`,
offline caches, and Ollama on 11435. Keep that runner and runtime online; missing
models or unavailable runners never become a passing quality check. Main requires
`check`, `contracts`, and `model-quality`. External fork runs require approval;
review their code before allowing execution on a dedicated runner.

OpenTelemetry writes bounded local JSONL files under `llm/artifacts/`; optional
existing Langfuse tracing accepts only a loopback endpoint. Summarize rates and
latency with `uv run --directory llm --no-sync python -m grapevine_llm.metrics artifacts/traces.jsonl`.
Gating time excludes model time; repair time includes the additional attempts.
Every failure and a deterministic 5% of successes enter a local review queue.
Text sampling is off by default. `GRAPEVINE_LLM_SAMPLE_TEXT=true` enables bounded,
best-effort redacted text, which still needs privacy review. Convert useful samples
to synthetic `GoldenCase` JSON, then use `maintenance promote candidate.json --reviewed`
and refresh the live baseline. Traces and review queues are never CI uploads.

Library choices: Instructor supplies typed parsing; Ollama's native schema mode
supplies constrained decoding, so no separate Outlines/xgrammar runtime is needed.
The existing DeepEval harness is retained with Ragas ID metrics. Hosted strict
APIs are deliberately unsupported by this air-gapped profile. uv/package locks
pin dependencies, including the compatible Ragas/LangChain pair and the existing
local DeepEval telemetry packaging patch.
