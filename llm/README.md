# Structured inference and offline quality gates

Pydantic v2 is the contract source for model inputs, outputs, tool arguments,
wire envelopes, and eval artifacts. The Node application calls one bounded Python
worker pool through `server/src/llm/gateway.ts`. Ollama, or vLLM or NVIDIA Triton when
selected, generates with the exported JSON Schema; Instructor and Pydantic validate the
complete response before it reaches application code. Generated Zod schemas check the
Node boundary again.

Defaults are three total attempts, one 120-second deadline, temperature 0, seed
42, and 16,384 context tokens. Temperature and the thinking switch come from the
model's [profile](#model-profiles). Repairs receive bounded validation errors. Failure
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
- The gate sends vLLM up to four generations at once by default. See
  [Sharing the GPU](#sharing-the-gpu).
- The required `model-quality` job stays on Ollama. Unit and worker tests cover the
  vLLM transport in CI, and the live vLLM run is manual.
- Under WSL mirrored networking use `127.0.0.1`. Windows gets no answer on `::1`, so
  Python clients wait about 21 s per new connection when given `localhost`.

### Live gates on vLLM

Measured at v0.8.1, on the 15 live cases the suite had then:

| Runtime         | Live cases | First pass | Judge scores  | Median model time | `checks quality`                     |
| --------------- | ---------- | ---------- | ------------- | ----------------- | ------------------------------------ |
| Ollama baseline | 15/15      | 15/15      | 1.0, 1.0, 1.0 | 1252 ms           | pass                                 |
| vLLM            | 15/15      | 14/15      | 1.0, 1.0, 1.0 | 1419 ms           | fail: first-pass rate 93%, needs 95% |

On vLLM, `empty-retrieval` needed three attempts where Ollama's baseline needed one, so
vLLM does not pass this gate yet. The gate is unchanged, and Ollama's baseline still applies.

## Triton runtime

`GRAPEVINE_LLM_RUNTIME=triton` sends the same requests to NVIDIA Triton Inference
Server 2.75.0 through its OpenAI-compatible frontend. Triton's vLLM backend serves the
same INT4 checkpoint with the same engine arguments as the `vllm serve` command above,
so the gate, the JSON Schema, the repair loop and the Pydantic and Zod checks do not
change. [evals/models.triton.json](evals/models.triton.json) pins the server version,
the image by digest, the vLLM build inside it, and a fingerprint of
[docker/triton](../docker/triton), which holds the model repository and start script.

```sh
TRITON_MODELS=/path/to/models docker compose --profile triton up -d
```

`TRITON_MODELS` is the directory that contains `RedHatAI/Qwen3.8-27B-INT4`. The
service needs Linux Docker with the NVIDIA Container Toolkit; on Windows that is Docker
inside WSL2, not Docker Desktop's Windows engine. It publishes the OpenAI frontend on
`127.0.0.1:9000` and KServe HTTP on `127.0.0.1:9001`, and nothing else. Set
`GRAPEVINE_LLM_RUNTIME=triton` in `server/.env`; the URL and model default to the
pinned record.

What is different from plain vLLM, and why:

- **The schema travels as a tool.** Triton's OpenAI frontend drops `response_format`
  and rejects request fields it does not know. The one route by which it hands a JSON
  Schema to the engine's constrained decoding is a named `tool_choice`, whose
  `parameters` become the constraint. So the transport sends the contract as a single
  tool, `grapevine_contract`, and reads the document from that call's arguments. Text
  outside the tool call was never constrained, and the transport refuses it.
- **Thinking is switched off in the template.** The frontend renders the chat template
  itself and takes no template arguments per request, so `start.sh` prefixes the
  checkpoint's template with two assignments: thinking off, and no tool list in the
  prompt. The model then sees the same prompt it sees on vLLM, with the schema in the
  system message.
- **The pin check reads the repository.** Triton reports its version, the served name
  and the backend, and neither the engine's arguments nor a weight digest. The check
  takes the source path and context length from the reviewed model repository, which
  the manifest fingerprints, and refuses to run if that directory was edited. That
  proves what was reviewed, not what a differently started server is running.
- **Admission sees less.** Triton's vLLM backend republishes vLLM's token and latency
  histograms but not its queue and KV cache gauges. On Triton the gate reads
  `nv_inference_pending_request_count` and nothing about the cache.

TensorRT-LLM was the other backend considered, and it is not used. At review time
(2026-11-18) Triton's TensorRT-LLM backend constrains output with XGrammar only, and
XGrammar refuses the agent schema for the same reason the vLLM engine runs `guidance`.
Release 26.11 also ships no TensorRT-LLM image, the model is not in TensorRT-LLM's
support tables, and an RTX 5090 under WSL2 is not a listed platform. A backend that
cannot enforce the contract would be a benchmark of a different product.

The required `model-quality` job stays on Ollama. Unit and worker tests cover the
Triton transport and pin check in CI, and live Triton runs are manual.

## Serving numbers

One harness measures all three runtimes the way the app uses them.
`python -m grapevine_llm.bench run` sends the agent contract through the gate's own
transport for the selected runtime, with schema-constrained decoding, temperature 0,
seed 42, thinking off and at most 256 output tokens, and validates every answer against
the contract. It is a closed loop: N streams stay in flight until 48 requests have
finished, or three per stream if that is more. There are two prompts. Short is three
event listings, about 436 prompt tokens on the INT4 tokenizer. Long is 35
listings, about 4,058. Every request starts with a different request number, so
nothing after the system message can be read from another request's prefix cache.
These are cache-miss numbers, the worst case for a first token. TTFT is the request
sent until the first generated token arrives, TPOT is the time per output token after
the first, and percentiles are nearest rank, so each one is a value that was observed.

Every file under [bench/results](bench/results) records what ran and on what:

| Runtime | Version                                        | Model              | Quantization                                      | Source                | GPU                                 | Driver | CUDA | Commit    |
| ------- | ---------------------------------------------- | ------------------ | ------------------------------------------------- | --------------------- | ----------------------------------- | ------ | ---- | --------- |
| Ollama  | 0.40.8                                         | `qwen3.8:27b`      | Q4_K_M GGUF                                       | `4610da9d4ad7afb2acc` | NVIDIA GeForce RTX 5090 (32607 MiB) | 621.14 | 13.5 | `9c2fdc9` |
| vLLM    | 0.33.0                                         | `qwen3.8-27b-int4` | W4A16 INT4 safetensors (AWQ + GPTQ), FP8 KV cache | `RedHatAI/Qwen3.8-27` | NVIDIA GeForce RTX 5090 (32607 MiB) | 621.14 | 13.5 | `0b8dd5f` |
| Triton  | 2.75.0 (vllm 0.33.0+908da4f6.nv26.11.80607662) | `qwen3.8-27b-int4` | W4A16 INT4 safetensors (AWQ + GPTQ), FP8 KV cache | `RedHatAI/Qwen3.8-27` | NVIDIA GeForce RTX 5090 (32607 MiB) | 621.14 | 13.5 | `0b8dd5f` |

The machine is an i7-14700KF with one RTX 5090 that also drives the desktop, which held
about 4.6 GiB of the card's memory (4,705 MiB before the vLLM and Triton runs). vLLM and Triton ran in WSL2
(Ubuntu 24.04), Triton through the compose service with its limits, and Ollama on
Windows. Each runtime had the GPU to itself. The two quantizations are different
weights of the same base model, so Ollama's rows compare a runtime and a quantization
together. Times are in ms; n is requests per row. No request failed and every answer
validated, on every row.

| Runtime | Prompt | Streams | n   | TTFT p50/p95/p99 ms | TPOT p50/p95/p99 ms | End-to-end p50/p95/p99 ms | tok/s per stream p50 | tok/s total | Errors | Invalid |
| ------- | ------ | ------- | --- | ------------------- | ------------------- | ------------------------- | -------------------- | ----------- | ------ | ------- |
| Ollama  | short  | 1       | 48  | 416/501/569         | 7.1/7.8/8.0         | 1319/1596/1668            | 140                  | 96          | 0      | 0       |
| Ollama  | short  | 4       | 48  | 4349/4676/4731      | 7.1/7.5/7.9         | 5313/5658/5703            | 141                  | 100         | 0      | 0       |
| Ollama  | short  | 8       | 48  | 9959/10230/10296    | 7.1/7.5/7.9         | 10953/11155/11217         | 141                  | 98          | 0      | 0       |
| Ollama  | short  | 16      | 48  | 20747/21356/21536   | 7.1/7.5/7.8         | 21718/22374/22391         | 141                  | 98          | 0      | 0       |
| Ollama  | short  | 32      | 96  | 41365/43392/43542   | 7.1/7.5/7.9         | 42257/44402/44534         | 140                  | 97          | 0      | 0       |
| Ollama  | long   | 1       | 48  | 1832/1880/1890      | 6.1/6.5/6.7         | 2993/3092/3165            | 162                  | 64          | 0      | 0       |
| Ollama  | long   | 4       | 48  | 10809/10936/10959   | 6.2/6.4/6.5         | 11970/12104/12164         | 162                  | 65          | 0      | 0       |
| Ollama  | long   | 8       | 48  | 22922/23157/23223   | 6.3/6.6/6.7         | 24138/24389/24433         | 159                  | 64          | 0      | 0       |
| Ollama  | long   | 16      | 48  | 46727/47126/47207   | 6.2/6.6/6.7         | 47914/48288/48383         | 162                  | 64          | 0      | 0       |
| Ollama  | long   | 32      | 96  | 95031/95654/95768   | 6.2/6.6/6.7         | 96238/96814/96905         | 161                  | 64          | 0      | 0       |
| vLLM    | short  | 1       | 48  | 148/157/158         | 12.0/12.0/12.0      | 1401/1542/1698            | 84                   | 75          | 0      | 0       |
| vLLM    | short  | 4       | 48  | 178/449/451         | 16.4/16.9/17.4      | 1997/2188/2317            | 61                   | 221         | 0      | 0       |
| vLLM    | short  | 8       | 48  | 348/881/883         | 17.8/20.4/23.3      | 2297/2906/3026            | 56                   | 374         | 0      | 0       |
| vLLM    | short  | 16      | 48  | 515/1733/1734       | 23.7/31.0/32.3      | 3167/4626/4686            | 40                   | 516         | 0      | 0       |
| vLLM    | short  | 32      | 96  | 3595/4686/5117      | 25.7/31.4/38.2      | 6639/7669/8318            | 39                   | 522         | 0      | 0       |
| vLLM    | long   | 1       | 48  | 1052/1058/1071      | 12.0/12.0/12.0      | 3136/3329/3359            | 83                   | 55          | 0      | 0       |
| vLLM    | long   | 4       | 48  | 1293/2299/4156      | 30.0/36.2/42.5      | 6451/7686/9540            | 33                   | 106         | 0      | 0       |
| vLLM    | long   | 8       | 48  | 1325/6478/8345      | 51.6/61.7/65.2      | 10482/14650/17901         | 19                   | 131         | 0      | 0       |
| vLLM    | long   | 16      | 48  | 3167/14895/18588    | 91.1/102.2/116.3    | 18785/31559/35601         | 11                   | 141         | 0      | 0       |
| vLLM    | long   | 32      | 96  | 21984/31478/37583   | 91.0/102.6/106.7    | 37365/48297/53891         | 11                   | 143         | 0      | 0       |
| Triton  | short  | 1       | 48  | 149/154/155         | 11.8/11.8/11.9      | 1381/1527/1675            | 85                   | 76          | 0      | 0       |
| Triton  | short  | 4       | 48  | 173/424/425         | 15.6/16.2/16.8      | 1933/2107/2292            | 64                   | 229         | 0      | 0       |
| Triton  | short  | 8       | 48  | 287/839/841         | 17.8/20.4/21.0      | 2315/2790/2881            | 56                   | 379         | 0      | 0       |
| Triton  | short  | 16      | 48  | 712/3135/3262       | 23.2/27.1/27.8      | 3353/5791/6318            | 43                   | 471         | 0      | 0       |
| Triton  | short  | 32      | 96  | 4063/6418/6631      | 23.8/27.3/29.5      | 6794/8925/9660            | 42                   | 474         | 0      | 0       |
| Triton  | long   | 1       | 48  | 1032/1040/1042      | 11.9/11.9/11.9      | 3058/3168/3278            | 84                   | 56          | 0      | 0       |
| Triton  | long   | 4       | 48  | 1086/3281/4085      | 29.6/35.1/35.9      | 6228/8270/9547            | 33                   | 107         | 0      | 0       |
| Triton  | long   | 8       | 48  | 1304/6357/8188      | 51.0/58.7/62.0      | 10324/14195/16647         | 20                   | 132         | 0      | 0       |
| Triton  | long   | 16      | 48  | 11480/16571/18452   | 51.1/63.0/69.3      | 19788/24822/27769         | 20                   | 132         | 0      | 0       |
| Triton  | long   | 32      | 96  | 31853/35118/39072   | 52.4/58.7/63.5      | 40766/43738/48450         | 19                   | 132         | 0      | 0       |

What the numbers say, and why:

- **Triton costs nothing at one stream.** 149 ms to the first token against vLLM's 148,
  and 11.8 against 12.0 ms per token. It is the same engine and the same weights, and
  one request does not notice the two extra hops.
- **Short prompts scale to 16 streams, then stop.** On vLLM total throughput goes 75,
  221, 374, 516 tok/s at 1, 4, 8 and 16 streams, while each stream slows from 12.0 to
  23.7 ms per token. At 32 it is 522. The engine runs 16 sequences at once
  (`max_num_seqs`), so the other 16 wait, and median TTFT goes from 515 to 3,595 ms:
  that is the wait for a slot.
- **Triton is a little behind at 16 short streams**: 471 tok/s against 516, and 712
  against 515 ms median TTFT. The KV cache is nowhere near full on short prompts, so the
  likely cost is each token crossing from the engine's process into Triton and out
  through its frontend. That was not measured separately.
- **Long prompts hit a ceiling near 143 tok/s** whatever the stream count: 106, 131,
  141, 143 tok/s at 4, 8, 16 and 32 on vLLM, and 132 on Triton from 8 up. The profile
  below shows why. The GPU is evaluating prompts, at about 4,000 prompt tokens a second,
  and each request brings about 4,000.
- **On long prompts Triton trades first-token time for token rate.** At 16 streams its
  median TTFT is 11.5 s against vLLM's 3.2 s, its TPOT is 51 against 91 ms, and
  end-to-end time and throughput are close (19.8 s and 18.8 s; 132 and 141 tok/s). The
  engines log the cause at startup. With the same `gpu_memory_utilization`, the engine
  inside Triton counts 19.72 GiB as consumed by weights and non-torch memory, against
  17.79 GiB natively, and the difference comes out of the KV cache: 2.77 GiB (73,400
  tokens) against 4.76 GiB (127,139 tokens). Triton therefore holds fewer long sequences
  at once. The rest wait longer for a slot and then decode with less company. Where the
  extra 1.9 GiB goes inside the container was not traced.
- **Ollama answers one request at a time, so streams only queue.** Its token rate does
  not change with load: 7.1 ms per token at 1 stream and 7.1 at 32, and total throughput
  stays between 96 and 100 tok/s at every level. What grows is the wait. Median TTFT on
  the short prompt is 416 ms alone, 4,349 ms at 4 streams and 41.4 s at 32: each request
  waits for the ones ahead of it to finish. Alone, it is the fastest of the three per
  token (7.1 ms against vLLM's 12.0), on different weights and with speculative decoding
  on, which is measured on vLLM further down, and from 4 streams up vLLM delivers more:
  221 tok/s against 100 at 4, 516 against 98 at 16. This is why the gate runs one
  generation at a time on Ollama and four on the others.
- **Ollama is slower to a first token even alone**, 416 against 148 ms on the short
  prompt and 1,832 against 1,052 ms on the long one, although it is the only runtime
  that read anything from a cache here: the system message every request shares, which
  is 41% of the short prompt's tokens and 4% of the long one's. vLLM logged a prefix
  cache hit rate of 0.0% through its run, because it caches this model in 800-token
  blocks and the shared part is shorter than one. The long prompt puts Ollama's prompt
  evaluation at roughly half vLLM's rate.
- **Against MLPerf's interactive limits** (p99 TTFT at or under 500 ms and p99 TPOT at
  or under 30 ms, from its Llama 3.1 8B interactive scenario; a yardstick, not a
  submission), the highest stream count inside both is: Ollama none on the short prompt
  and none on the long one; vLLM 4 on the short prompt and none on the long one; Triton
  4 on the short prompt and none on the long one. No runtime meets the TTFT limit on a
  4,000-token prompt without a cache hit.

### Where the time goes on the slowest level

Long prompts at 16 streams on vLLM, measured three ways over the same 48-request level.
The instrumented runs stayed close to the plain one: median TTFT 3.3 to 3.9 s against
3.2 s, TPOT 84 to 91 ms against 91, and 134 to 137 tok/s against 141. The instruments cost a few percent and did not change the picture.

| Source                                                               | What it showed                                                                                                                                                                                                                                                |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| vLLM's own request timers, mean per request                          | 3.68 s waiting in the engine's queue, 1.30 s of prefill, 13.05 s decoding 167 tokens, 5.33 s to the first token. The engine evaluated 195,161 prompt tokens and generated 8,201.                                                                              |
| NVIDIA Nsight Systems 2026.1.3, CUDA trace of the engine under WSL2  | GPU kernels ran for 50.2 s of the 60.3 s window. 87.3% of that was the Marlin 4-bit matmul, 4.2% the model's linear-attention kernels, 2.7% dense GEMM, 2.6% FlashInfer paged-KV attention, 2.3% compiled elementwise kernels. Memory copies took 0.09 s.     |
| PyTorch profiler, through vLLM's `--profiler-config`, engine process | 59.5 s of CPU time, 33.7 s of it in "Command Buffer Full", which CUPTI documents as overhead due to lack of command buffer space, and 4.1 s of self time in the linear-attention op. Its trace held no GPU kernel events, so the GPU split above is Nsight's. |

Together: this level is bound by prompt evaluation in the quantized matmul. Twenty-four
prompt tokens are evaluated for every token generated, the GPU is busy with kernels for
five sixths of the window, and nearly all of that is one kernel. The engine thread
spends more than half its time in an overhead that means the driver had no room for
more commands, which reads as the CPU waiting on the GPU and not the other way round.
First-token time is mostly the wait for a slot, 3.7 s of 5.3 s, because the KV cache is
full: during this level vLLM reported 15 sequences running with its cache 94% used.
More streams, more CPU or a different frontend would not move these numbers. A prefix
cache hit does, and in the app most of a turn's prompt is the event digest it shares
with the last turn:

Long prompt first answer token, one stream, p50, with the share of prompt tokens read
from the prefix cache. Measured at v0.8.1 with `vllm bench serve`, 128 output tokens,
on vLLM 0.33.0 and Ollama 0.40.13:

| Runtime | Miss    | Same prompt repeated | Same document, new question |
| ------- | ------- | -------------------- | --------------------------- |
| vLLM    | 1059 ms | 231 ms, 80%          | 232 ms, 80%                 |
| Ollama  | 1505 ms | 105 ms, 99.9%        | 296 ms, 87.8%               |

vLLM caches this hybrid model in 800-token blocks, so a repeat still evaluates the
last partial block.

Profiling Triton's engine the same way needs Nsight inside the container, which was
not set up, so the Triton engine was not profiled.

### Against the model's own recommendations

Checked on 2026-11-18 against the Qwen3.8-27B model card and the card of the
`RedHatAI/Qwen3.8-27B-INT4` checkpoint. Where this deployment departs from them, the
departure is listed, not hidden.

| Topic                  | The cards say                                                                                        | This deployment                                                                                                                                                 |
| ---------------------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Thinking off           | `chat_template_kwargs: {"enable_thinking": false}`                                                   | The same, per request, on vLLM. The same switch set in the chat template on Triton. `think: false` on Ollama.                                                   |
| vLLM parsers           | `--reasoning-parser qwen3 --enable-auto-tool-choice --tool-call-parser qwen3_xml`                    | The same.                                                                                                                                                       |
| Sampling, thinking off | temperature 0.7, top_p 0.8, top_k 20, presence_penalty 1.5                                           | Temperature 0 and seed 42, so that the gates can compare one run with another. Chat therefore does not sample the way the authors tuned for. Not measured here. |
| Speculative decoding   | The checkpoint card serves with `--speculative-config '{"method":"mtp","num_speculative_tokens":3}'` | Off on vLLM and Triton in the table above. On in Ollama: its log shows MTP drafts of up to four tokens with 71% of drafted tokens accepted.                     |
| Context length         | 262,144 tokens natively                                                                              | 65,536 served on vLLM and Triton, and 16,384 per request from the gate.                                                                                         |
| Quantization           | W4A16: AWQ smoothing, then GPTQ, with an FP8 KV cache. 98.5% to 101.1% of BF16 on six benchmarks     | As pinned. Those recovery figures are the card's, with its own sampling settings, and were not reproduced here.                                                 |

The speculative decoding row matters for reading the table. Ollama's lead per token, 7.1
ms against vLLM's 12.0, is a runtime, a quantization and speculative decoding together,
not a runtime alone.

Measured here in a short run that is kept apart from the gated results:
[bench/experiments/vllm-mtp.json](bench/experiments/vllm-mtp.json), with the serve
command and the engine's own readings in
[bench/experiments/README.md](bench/experiments/README.md). vLLM would not start with
that flag at the documented 65,536-token context. With it the engine reports 0.8 GiB
more in weights and other fixed memory and 1.7 GiB more in peak activations, which
leaves 2.2 GiB for the KV cache where the committed flags leave 4.76, and that context
needs 3.06. At 32,768 tokens it starts, with a KV cache of 35,288 tokens against
127,139, and the engine accepted 74% to 82% of the tokens it drafted. "Without" is the
committed vLLM result at 65,536 tokens. No request failed or returned an invalid object
in either:

| Level      | Requests, without / with | TTFT p50 ms, without / with | TPOT p50 ms, without / with | tok/s total, without / with |
| ---------- | ------------------------ | --------------------------- | --------------------------- | --------------------------- |
| short x 1  | 48 / 24                  | 148 / 162                   | 12.0 / 6.4                  | 75 / 128                    |
| short x 4  | 48 / 24                  | 178 / 374                   | 16.4 / 7.9                  | 221 / 311                   |
| short x 16 | 48 / 48                  | 515 / 4,766                 | 23.7 / 8.1                  | 516 / 308                   |
| long x 1   | 48 / 24                  | 1,052 / 1,074               | 12.0 / 6.3                  | 55 / 80                     |
| long x 4   | 48 / 24                  | 1,293 / 4,156               | 30.0 / 12.1                 | 106 / 105                   |
| long x 16  | 48 / 48                  | 3,167 / 22,843              | 91.1 / 12.0                 | 141 / 107                   |

Speculative decoding nearly halves the time per token, to 6.4 ms against 12.0, which is
under Ollama's 7.1, and one stream gets 128 tok/s against 75. At four short streams it
still delivers more, 311 tok/s against 221, though the first token takes 2.1 times as
long. Past that the cache decides. The engine's log shows one request filling about a
third of the smaller cache whatever its length (31.7% for the 436-token prompt, 36.6%
for the 4,058-token one), so it ran three short requests or two long ones at a time and
deferred the rest. At 16 short streams throughput is 40% lower and the first token takes
9 times as long. Why one request takes that much of the cache was not traced. vLLM also
capped the tokens it schedules per step at 2,048 under speculative decoding and
suggested raising `max_num_batched_tokens`. That was left alone, so this is the card's
flag as given and not a tuned configuration.

On this card, with the desktop on it, the two settings suit different loads: speculative
decoding for one person at a time, and the committed flags for the concurrent serving
this release adds. The committed flags and baselines are unchanged. The choice is
recorded in the model's [profile](#model-profiles), next to the run that measured it.

### The regression gate

`python -m grapevine_llm.bench check` holds every result in `bench/results` to the file
of the same name in `bench/baseline`, and the `contracts` job runs it on every pull
request, also against the base branch's baseline so a change cannot slow a runtime and
replace its baseline together. A level fails when a median is more than 15% slower, a
p95 more than 30% slower (p99 too, once both runs have 100 samples), total throughput
more than 15% lower, or any request fails or returns an invalid answer that the
baseline did not. A latency change also has to exceed an absolute floor (25 ms of TTFT,
1.5 ms of TPOT, 100 ms end to end) before it counts. Runs of a different runtime
version, model, quantization, weight source, container or GPU are refused, not
compared, and so is a run from a runtime that did not match its pinned record.

Hosted CI has no GPU, so it gates the committed numbers. Measuring is a separate,
manual step: the `Serving benchmark` workflow runs the harness on the GPU runner against
whichever runtime is up and fails on the same comparison. To measure by hand and adopt
a result:

```sh
GRAPEVINE_LLM_RUNTIME=vllm uv run --directory llm --no-sync python -m grapevine_llm.bench run --output bench/results/vllm.json
uv run --directory llm --no-sync python -m grapevine_llm.bench check
# After reading the numbers, make the result the new baseline.
uv run --directory llm --no-sync python -m grapevine_llm.bench accept bench/results/vllm.json --reviewed
```

The bands are set above measured repeat error. Two back-to-back runs of the vLLM matrix
on this machine, same flags and same harness, differed by at most 5% in TPOT, 6% in
median end-to-end time, 15% in p95 end-to-end time and 2.4% in throughput. Median TTFT
with more than one stream did not repeat: it moved by up to 26% (277 to 348 ms at 8
streams), which fits a closed loop where a request's wait depends on where in the
engine's batch it lands. So TTFT at
more than one stream gets a wider band, 40% at the median and 50% at p95, and the tight
bands apply to everything else. Two runs is a small sample; a band that proves wrong
should be changed with the evidence in the commit.

## Sharing the GPU

One card serves every chat turn, every inbox extraction, discovery and the eval
judges. Four mechanisms decide who gets it. Each is small, and each has a test that
fails if it stops working.

**Two priority classes.** The gate (`server/src/llm/gateway.ts`) keeps a pool of
Python workers, one per generation in flight: 1 on Ollama, which answers one request at
a time, and 4 on vLLM and Triton, which batch (`GRAPEVINE_LLM_CONCURRENCY`). A chat turn
is interactive. Extraction, discovery and eval judging are background. Interactive work
always starts first. Background work may hold all but one slot, so a person never
arrives behind a full set of extractions. When every slot is busy anyway, the newest
background job is stopped and the chat turn takes its worker; the stopped job goes back
to the head of its queue and runs again from the start. A job is stopped at most twice,
then it is left to finish. Each queue has a length limit (16 interactive, 64
background) and a wait limit (30 s and 10 min), and past either the caller gets a typed
`busy` error instead of an unbounded wait. Stopping one request kills only its own
worker. The policy is a pure function in
[scheduler.ts](../server/src/llm/scheduler.ts), tested in
[scheduler.test.ts](../server/test/scheduler.test.ts) and, with stand-in worker
processes, in [gate-pool.test.ts](../server/test/gate-pool.test.ts).
[gate-worker.test.ts](../server/test/gate-worker.test.ts) runs two real workers at once
in CI.

**Admission from what the runtime reports.** Before background work starts, the gate
asks the runtime how loaded it is ([admission.ts](../server/src/llm/admission.ts)) and
holds the job while any of these is true:

| Reading                             | Source                                                                        | Holds background work when                                           |
| ----------------------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Requests waiting in the engine      | vLLM `vllm:num_requests_waiting`; Triton `nv_inference_pending_request_count` | more than 0                                                          |
| KV cache in use                     | vLLM `vllm:kv_cache_usage_perc`                                               | 85% or more                                                          |
| Free GPU memory against a cold load | Ollama `/api/ps` and `/api/tags`, with `nvidia-smi`                           | the model is not loaded and free memory is under its size plus 1 GiB |

A reading the runtime does not give is unknown, and unknown admits: a missing metric
must not stop extraction forever. Interactive work is never held by a reading. The
thresholds are `GRAPEVINE_LLM_ADMIT_*`, and `GRAPEVINE_LLM_ADMISSION=off` skips the
check. Run against vLLM during the benchmark's 32-stream long-prompt level, the probe
read 15 requests running, 17 waiting and a KV cache 94% full, and the decision was to
hold background work.

**Limits per person.** A chat request passes three, each counted per account, or per
address when nobody is signed in ([chat.ts](../server/src/agent/chat.ts)): 20 turns a
minute, one stream at a time, and a daily token budget
([quota.ts](../server/src/quota.ts)). The budget is 500,000 tokens a UTC day for an
account and 100,000 for a signed-out address (`CHAT_DAILY_TOKENS`,
`CHAT_DAILY_TOKENS_ANON`; 0 removes the limit). What is charged is what the runtime
reported for the turn: prompt tokens it evaluated, so not the ones read back from its
prefix cache, plus output tokens, over every model call in the turn. A turn is charged
after it runs, so the budget can be overshot by one turn. Accounts are counted in
Postgres (`llm_usage`, one row per account per day, written by one atomic function), so
a restart does not hand out a fresh day. If that table cannot be reached, the count
continues in the server process and chat carries on. A refused request gets HTTP 429
with `Retry-After`.

**Limits per container.** The Triton service in
[docker-compose.yml](../docker-compose.yml) is capped at 8 CPUs and 12 GB of host
memory, runs with every Linux capability dropped, and is the only compose service given
a GPU. Through the whole benchmark it used at most 8.8 GiB of that memory and was never
restarted. Docker has no limit for GPU memory, so that one is the engine's own:
`gpu_memory_utilization` 0.78 in the model repository, which the pin check fingerprints.

`GET /readyz` reports the pool under `gate`: slots, workers, what is running and queued
in each class, how many times a person pushed background work aside, how many requests
were refused as busy, how many times background work was held, and the runtime's last
reading.

## Agent turn latency

Measured against MLPerf's interactive latency limits: p99 TTFT at or under 500 ms and p99
TPOT at or under 30 ms, the limits of its Llama 3.1 8B interactive scenario. These are local
measurements on one RTX 5090 with an i7-14700KF, not an MLPerf submission. `npm run
bench:ttft -w server` drives the real route, graph, rails and gate one request at a time,
warm, with a 1.5 s gap between turns. The store is a fixture, so a deployment's database
round trip is not in the visible numbers.

Model TTFT is the request sent to the runtime until its first generated token. Visible TTFT
is the POST until the first `delta` frame reaches the client. Times are in ms.

Ollama 0.40.8, `qwen3.8:27b`, on 24addce. The long prompt holds 120 events and is p50/p95/p99;
the short one is p50/p95:

| Turn           | Prompt tokens | n   | Model TTFT  | Visible TTFT | Model TPOT | Visible TPOT | End to end    | Output tok/s | Cache hit |
| -------------- | ------------- | --- | ----------- | ------------ | ---------- | ------------ | ------------- | ------------ | --------- |
| Long, no tool  | 10575         | 105 | 294/311/337 | 555/685/703  | 7/8/8      | 13/15/18     | 818/1180/1190 | 82/93/93     | 97.6%     |
| Short, no tool | 7808          | 30  | 293/309     | 539/663      | 7/8        | 13/18        | 776/1406      | 80/98        | 96.9%     |

On the long prompt, model TTFT and both TPOT measures are inside the limits. Visible TTFT is
outside them, already at p50. The JSON envelope comes first, which puts the model's first answer
word at p99 491 ms. The persona filter then holds back 64 characters, so an answer shorter than
that shows nothing until it finishes. Cold, with a model load, model TTFT was about 9.4 s long
and 8.4 s short (n=3 each). A prompt cache miss is not in these runs.

There is no before number to compare with. The baseline run on the old code timed out, and its
no-tool turns returned errors, so nothing here claims an improvement.

Measured one commit earlier, on c4ec9b7, before the prompt gained about 170 tokens and a restated
question after each tool result. p50/p95, smaller samples, so treat these as rough:

| Turn                        | Prompt tokens | n   | Model TTFT | Visible TTFT | Model TPOT | Visible TPOT | End to end | Output tok/s | Cache hit |
| --------------------------- | ------------- | --- | ---------- | ------------ | ---------- | ------------ | ---------- | ------------ | --------- |
| Ollama, short, tool first   | 7731          | 7   | 219/245    | 1331/2023    | 6/7        | 8/13         | 2263/3771  | 89/97        | 98.7%     |
| vLLM 0.33.0, short, no tool | 7653          | 24  | 412/426    | 1067/1289    | 13/14      | 21/36        | 1505/4123  | 40/46        | n/a       |
| vLLM 0.33.0, long, no tool  | 10400         | 26  | 297/308    | 964/1337     | 14/14      | 21/32        | 1542/3922  | 45/52        | n/a       |

On vLLM, 8 of 56 turns retracted text and showed a repaired answer, against 0 of 213 on Ollama at
that commit. Tool-first p95 is close to a maximum at n=7.

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

## Model profiles

A profile is one reviewed record per model family, in [evals/profiles](evals/profiles).
It holds what differs from one family to the next: how the gate asks the model, what its
evals have to clear, and what its publisher recommends. Code reads the first two, so they
are enforced and not only written down.

| Part         | What it holds                                                                                                              | Read by                                                                         |
| ------------ | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `served`     | The exact model names it governs, per runtime                                                                              | Matching. A profile applies to those names and to no others.                    |
| `request`    | Temperature, thinking on or off, the chat-template keyword vLLM takes for thinking, and whether system messages are merged | `client.py`, for every request from the gate, the Ragas judge and the benchmark |
| `gates`      | The judge pass mark, the faithfulness floor and allowed drop, the first-pass rate, and what they were set from             | `checks.py` and `server/scripts/llm-quality.ts`                                 |
| `facts`      | What a source states about the family, each with the source and the date it was read                                       | Nothing. They are the record the departures are written against.                |
| `departures` | Where this deployment does something other than what the publisher says, why, and the committed result that measured it    | The gate, which fails if a named result file is missing.                        |

Two are committed:

- [qwen3.8](evals/profiles/qwen3.8.json) is reviewed. It governs `qwen3.8:27b` on Ollama
  and `qwen3.8-27b-int4` on vLLM and Triton. Its request settings are the ones the gate
  already sent, so adopting it changed no request. Its departures are the table under
  [Against the model's own recommendations](#against-the-models-own-recommendations) as
  data: sampling, speculative decoding and context length, the last two with the result
  files that measured them. Its thresholds are the ones described under [Ragas](#ragas).
- [claude-fable-5.2](evals/profiles/claude-fable-5.2.json) is imported: twelve facts from
  models.dev and nothing measured here. No runtime in this repository serves it and the
  gates refuse it. It is kept because one of its facts shows why thresholds cannot be
  carried from one family to the next. models.dev lists it as not accepting a
  temperature, and every gate above rests on temperature 0, so two runs of it could not
  be compared the way two runs of Qwen are.

The rules the code holds:

- A model with no profile still gets requests, with the settings the gate sent before
  profiles existed (temperature 0, thinking off). Any model picked in Admin works as it
  did. The eval gates stop with "no reviewed profile".
- The judge has to be governed by the same profile as the model it judges. The
  thresholds were measured with one family doing both jobs.
- A profile and the manifest of each runtime it names must agree on temperature.
- The profile is part of the model fingerprint in every eval artifact. Editing it makes
  the baseline stale, the same as changing a model pin.

To add a family, import its catalog facts, then measure:

```sh
npm run profiles:import -- --provider anthropic --model claude-fable-5-2 --family claude-fable-5.2
```

That writes an imported profile from [models.dev](https://models.dev), the open catalog
the server's model picker already reads. Running it again refreshes those facts and their
date and leaves everything a person wrote. Prices are not imported, because they belong
to a host and not to the model. To make the profile reviewed:

1. Record what the model card recommends as `facts`, each with a link and a date.
2. Serve the model, pin it in a manifest, and fill in `served` and `request`.
3. Run the live suite several times. Hold case by case what repeats exactly and on the
   suite average what does not, and write what you saw in `gates.calibration`.
4. List each place the deployment departs from the card under `departures`. Name the
   committed result for anything measured.
5. Set `status` to `reviewed` and promote a baseline.

The hosted speed, price and index figures in the Qwen profile are from
[Artificial Analysis](https://artificialanalysis.ai/), read on 2026-11-18 through its free
Data API. They describe hosted endpoints, not this deployment, and are there for
comparison only.

## Cases, scores, and baselines

[evals/golden.jsonl](evals/golden.jsonl) contains 33 synthetic, locally stored cases:
normal extraction/ratings/tools, malformed output, coercion, invalid IDs, repair
exhaustion, injection, empty evidence, and evidence sets with distractors, two
relevant listings, and a retriever miss. Eighteen also run on the real model.
Copy a case, give it a unique matching request ID, and add exact field checks.
`responses` drives deterministic replay, not the live run. Set `live: true` for
model cases and add an explicit `rubric` only for subjective criteria.

The live run also drives whole turns through the real graph, gate and model. One is a
tool round: the model asks for a tool, the result goes back, and the answer has to use
it. Golden cases are single generations and cannot see that path, and on 2026-11-04 it
turned out every tool turn had been failing since v0.7.0 with all of them green. Five are
ordinary questions the concierge once deflected, two of them with injected text, so a
prompt that answers "I'm Grapevine" in place of the answer fails the gate.

Deterministic failures stop the run before judging. DeepEval applies local typed
judges with explicit score anchors. RAG answers additionally receive groundedness
and relevance rubrics. The starter judge shares the generation model; it is not an
independent measure of correctness. Follow [calibration.md](calibration.md) for
human review.

### Ragas

Ragas 0.4.4 scores every agent case of a live run three ways, and the artifact keeps
each number per case with a macro average in `retrieval`:

- **Retrieval precision and recall**, from IDs alone: of the evidence the case put in
  front of the model, how much was relevant, and was everything relevant there. This
  scores the reviewed snapshot in the golden case. It does **not** benchmark the live
  Supabase retriever, and it does not move unless a case is edited.
- **Citation precision and recall**, from IDs alone: of the evidence the answer cited,
  how much was relevant, and did it cite everything relevant. This is the model's
  output, so it moves when grounding gets better or worse. A case built with
  distractors measures precision, one with two relevant listings measures recall, and
  `retriever-miss` shows the two apart: its retrieval recall is 0.5 by construction,
  which caps citation recall at 0.5 however good the answer is.
- **Faithfulness**, judged: Ragas splits the answer into atomic statements and checks
  each against the evidence text, and the score is the share that are supported. It
  runs on the pinned local model through `grapevine_llm/ragas_local.py`, with the
  gate's seed, temperature and schema-constrained decoding, and a reply that does not
  validate is retried and then refused. It is asked only of an answer that makes
  claims and had evidence to check them against.

The checked-in baseline, from a live run on the pinned Ollama model:

| Case                   | Evidence in the case                                             | Retrieval precision / recall | Citation precision / recall | Faithfulness |
| ---------------------- | ---------------------------------------------------------------- | ---------------------------- | --------------------------- | ------------ |
| `grounded-jazz`        | one relevant listing and nothing else                            | 1.00 / 1.00                  | 1.00 / 1.00                 | 0.67         |
| `empty-retrieval`      | no evidence at all                                               | 1.00 / 1.00                  | 1.00 / 1.00                 | n/a          |
| `injected-evidence`    | one relevant listing, with injected text beside it               | 1.00 / 1.00                  | 1.00 / 1.00                 | 1.00         |
| `grounded-distractors` | one relevant listing among three that match part of the question | 0.25 / 1.00                  | 0.50 / 1.00                 | 1.00         |
| `grounded-two-events`  | two relevant listings and one distractor                         | 0.67 / 1.00                  | 1.00 / 1.00                 | 1.00         |
| `retriever-miss`       | one of the two relevant listings was retrieved                   | 0.50 / 0.50                  | 1.00 / 0.50                 | 1.00         |
| `known-id-tool`        | a tool turn, with no evidence                                    | 1.00 / 1.00                  | 1.00 / 1.00                 | n/a          |
| **Average**            | 7 agent cases, 5 judged                                          | 0.77 / 0.93                  | 0.93 / 0.93                 | 0.93         |

The gate requires both ID pairs on every agent case and refuses a per-case drop in any
of the four against the baseline. They are set arithmetic over IDs, with no judge, and
five live runs gave the same four scores for every case, and the same rubric scores.
The words are less fixed than the scores. At temperature 0 with a fixed seed, one of
those runs worded the `injected-evidence` answer differently, with the same citation,
and the rubric judge's reason for one case varied in its quotation marks. The table is
the model's real behavior, not a row of ones. In `grounded-distractors` it answered correctly and also
cited the ticketed jazz show it was ruling out, which halves citation precision.

Faithfulness is gated on the suite average, which must be at least 0.75 and no more
than 0.15 below the baseline's, because the judge is not repeatable case by case. Both
numbers are the Qwen [profile](#model-profiles)'s, set from the runs described here. Over
the same five runs four of the five judged answers scored 1.0 every time, and
`grounded-jazz` scored 0.67, 1.0, 0.67, 1.0, 0.67 on an identical answer: "You can
attend Shoreline Jazz at Waterfront Park on Friday, November 6, 2026, from 7 PM to 9 PM.
Admission is free." The first three were taken apart. For both low scores the judge had
split the answer into three claims and refused the first, that the user can attend,
because the evidence says nothing about the user. For the high one it had split it into
two and accepted both. One such flip moves the average of five cases by 0.07, and the
checked-in baseline is a run where it fell the low way.
Read a faithfulness number as a reason to look at the answer, not as a verdict on it.
It shares the generation model, like the DeepEval judge, and the same caution applies.

Ragas 0.4 deprecates the ID metrics' import path and names no replacement before 1.0,
so the dependency is held below 0.5 and `tests/test_ragas.py` keeps the set arithmetic
on record.

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
per-case score or first-pass regression. The two thresholds are read from the pinned
model's [profile](#model-profiles), and a model without a reviewed one fails the gate. Timing in this artifact is recorded, not
gated; serving latency has its own gate, under [Serving numbers](#serving-numbers).
Artifacts include per-case outputs, attempts,
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
supplies constrained decoding, and vLLM uses its `guidance` backend when selected,
directly or inside Triton. The existing DeepEval harness is retained with Ragas ID
metrics and Ragas faithfulness. Hosted strict
APIs are deliberately unsupported by this air-gapped profile. uv/package locks
pin dependencies, including the compatible Ragas/LangChain pair and the existing
local DeepEval telemetry packaging patch.
