# Structured inference and offline quality gates

Pydantic v2 is the contract source for model inputs, outputs, tool arguments,
wire envelopes, and eval artifacts. The Node application calls one bounded Python
worker through `server/src/llm/gateway.ts`. Ollama, or vLLM when selected, generates
with the exported JSON Schema; Instructor and Pydantic validate the complete response before it reaches
application code. Generated Zod schemas check the Node boundary again.

Defaults are three total attempts, one 120-second deadline, temperature 0, seed
42, and 16,384 context tokens. Repairs receive bounded validation errors. Failure
returns a typed error with no partial output. One thing leaves the gate early: the
agent's answer text streams to the person as it generates, as `StreamFrame` display
text, and the complete document still validates at the end. If an attempt fails, the
worker says so and the app takes back what it showed. Tool calls, citations and every
other task arrive only in the validated result, so nothing acts on unvalidated output.
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

## vLLM runtime

Ollama stays the default. `GRAPEVINE_LLM_RUNTIME=vllm` sends structured inference
and chat to vLLM's OpenAI-compatible endpoint instead, with the same JSON Schema,
repair loop, and Pydantic and Zod gates. Thinking stays off through
`chat_template_kwargs`. [evals/models.vllm.json](evals/models.vllm.json) pins vLLM
0.33.0 and `RedHatAI/Qwen3.8-27B-INT4` by revision and hash.

That is the same base model as `qwen3.8:27b`, with different weights: W4A16 GPTQ
safetensors and an FP8 KV cache, against Ollama's Q4_K_M GGUF. vLLM 0.33.0 cannot
load the GGUF, because `vllm-gguf-plugin` 0.0.5 has no mapping for the model's
linear attention tensors. Start the server with:

```sh
vllm serve /path/to/RedHatAI/Qwen3.8-27B-INT4 \
  --served-model-name qwen3.8-27b-int4 --host 127.0.0.1 --port 8000 \
  --reasoning-parser qwen3 --enable-auto-tool-choice --tool-call-parser qwen3_xml \
  --structured-outputs-config '{"backend":"guidance"}' \
  --max-model-len 65536 --gpu-memory-utilization 0.78 --max-num-seqs 16
```

Then set `GRAPEVINE_LLM_RUNTIME=vllm` in `server/.env`, where the URL and model
default to the pinned record. For the live gates, set the same variable in the shell:

```sh
node --import ./server/scripts/eval-network.mjs --import tsx ./server/scripts/llm-quality.ts --live
uv run --directory llm --no-sync python -m grapevine_llm.checks quality --report artifacts/live.json --base-ref origin/main
```

The gate compares a vLLM run against Ollama's checked-in baseline. The judge is the
served vLLM model, because vLLM holds the GPU while it runs.

Known limits:

- The `guidance` backend is required. The agent schema combines `pattern` with
  length limits, which xgrammar refuses, and vLLM allows one backend per engine.
  Under `guidance`, `tool_choice: "required"` and a named `tool_choice` return HTTP 400.
  Grapevine sends neither: tool requests travel inside the agent's JSON Schema.
- vLLM reports no weight digest. The pin check compares the version, served name,
  source path, and context length. Check the weights by hand with `sha256sum`.
- The Node gate runs one worker that handles one request at a time, so the app
  does not use vLLM's concurrency yet.
- The required `model-quality` job stays on Ollama. Unit and worker tests cover the
  vLLM transport in CI, and the live vLLM run is manual.
- Under WSL mirrored networking use `127.0.0.1`. Windows gets no answer on `::1`, so
  Python clients wait about 21 s per new connection when given `localhost`.

### Serving numbers

Measured against MLPerf's interactive latency limits: p99 TTFT at or under 500 ms and
p99 TPOT at or under 30 ms, the limits of its Llama 3.1 8B interactive scenario. These
are local measurements on one RTX 5090 (32 GB, WSL2 for vLLM, Windows for Ollama),
not an MLPerf submission. The tool is `vllm bench serve` with temperature 0, thinking
off, 128 output tokens, warm, and unique prompts of 61 or about 3,990 tokens.

- vLLM 0.33.0: INT4 weights, 65,536 max length, 16 sequences, no speculative decoding,
  40 to 80 requests per row.
- Ollama 0.40.13: Q4_K_M weights, `num_ctx` 100000, `OLLAMA_NUM_PARALLEL=1`, MTP drafts
  on (`draft_num_predict` 4), 30 to 48 requests per row. It serves streams in turn.

| Runtime | Prompt | Streams | TTFT p50/p95/p99 ms | TPOT p50/p95/p99 ms | End-to-end p50/p95/p99 ms | tok/s per stream | tok/s total |
| ------- | ------ | ------- | ------------------- | ------------------- | ------------------------- | ---------------- | ----------- |
| vLLM    | short  | 1       | 54/58/60            | 11.8/12.6/12.6      | 1556/1658/1658            | 85               | 81          |
| vLLM    | short  | 4       | 110/118/118         | 13.0/13.1/13.1      | 1764/1773/1774            | 77               | 290         |
| vLLM    | short  | 8       | 169/190/190         | 13.0/13.4/13.5      | 1822/1848/1849            | 77               | 566         |
| vLLM    | short  | 16      | 293/322/322         | 14.4/15.3/15.6      | 2120/2219/2220            | 69               | 954         |
| vLLM    | long   | 1       | 1041/1067/1117      | 12.5/12.7/12.7      | 2628/2682/2735            | 80               | 50          |
| vLLM    | long   | 4       | 1569/1889/3094      | 34.4/38.1/38.8      | 5990/6425/7876            | 29               | 87          |
| vLLM    | long   | 8       | 1583/5270/7097      | 62.2/66.0/66.8      | 9441/13329/15169          | 16               | 108         |
| vLLM    | long   | 16      | 2429/11371/14860    | 118.1/122.4/123.3   | 17772/25911/29568         | 8                | 115         |
| Ollama  | short  | 1       | 199/218/220         | 9.1/9.7/10.2        | 1351/1442/1519            | 110              | 96          |
| Ollama  | short  | 4       | 3982/4312/4343      | 8.8/10.1/10.4       | 5084/5472/5502            | 113              | 99          |
| Ollama  | short  | 8       | 9153/9586/9624      | 8.8/10.2/10.5       | 10330/10732/10856         | 113              | 98          |
| Ollama  | short  | 16      | 20243/20952/21038   | 9.4/10.7/10.9       | 21484/22106/22217         | 107              | 95          |
| Ollama  | long   | 1       | 1379/1460/1478      | 8.8/10.2/10.6       | 2500/2704/2750            | 114              | 52          |
| Ollama  | long   | 4       | 8834/8998/9061      | 9.0/10.6/11.0       | 9972/10229/10305          | 112              | 52          |
| Ollama  | long   | 8       | 19203/19860/19913   | 9.1/10.3/10.9       | 20355/21086/21164         | 110              | 51          |
| Ollama  | long   | 16      | 39933/40475/40600   | 9.4/10.5/11.0       | 41078/41671/41839         | 106              | 50          |

Highest stream count within both limits, short prompt: vLLM 16 (the most tested),
Ollama 1. Neither runtime meets the TTFT limit on a 4,000-token prompt without a cache
hit; their best are 1117 ms (vLLM) and 1478 ms (Ollama) at one stream.

Long prompt first answer token, one stream, p50, with the share of prompt tokens read
from the prefix cache:

| Runtime | Miss    | Same prompt repeated | Same document, new question |
| ------- | ------- | -------------------- | --------------------------- |
| vLLM    | 1059 ms | 231 ms, 80%          | 232 ms, 80%                 |
| Ollama  | 1505 ms | 105 ms, 99.9%        | 296 ms, 87.8%               |

vLLM caches this hybrid model in 800-token blocks, so a repeat still evaluates the
last partial block.

### Live gates

| Runtime         | Live cases | First pass | Judge scores  | Median model time | `checks quality`                     |
| --------------- | ---------- | ---------- | ------------- | ----------------- | ------------------------------------ |
| Ollama baseline | 15/15      | 15/15      | 1.0, 1.0, 1.0 | 1252 ms           | pass                                 |
| vLLM            | 15/15      | 14/15      | 1.0, 1.0, 1.0 | 1419 ms           | fail: first-pass rate 93%, needs 95% |

On vLLM, `empty-retrieval` needed three attempts where Ollama's baseline needed one, so
vLLM does not pass this gate yet. The gate is unchanged, and Ollama's baseline still applies.

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
supplies constrained decoding, and vLLM uses its `guidance` backend when selected.
The existing DeepEval harness is retained with Ragas ID metrics. Hosted strict
APIs are deliberately unsupported by this air-gapped profile. uv/package locks
pin dependencies, including the compatible Ragas/LangChain pair and the existing
local DeepEval telemetry packaging patch.
