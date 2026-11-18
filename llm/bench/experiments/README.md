# Experiments

Benchmark runs that informed a decision and are not gated. `bench check` reads only
`../results` and `../baseline`, so nothing in this directory can pass or fail CI.

## vllm-mtp.json: speculative decoding on vLLM

The `RedHatAI/Qwen3.8-27B-INT4` model card serves the checkpoint with multi-token
prediction drafts. The committed vLLM flags do not. This run measures what the flag
changes on this machine. It was taken on 2026-11-18 at revision `9c2fdc9` with
uncommitted changes in the tree, which is why the file's revision ends in `-dirty`.

The server was the documented vLLM command with two changes: the speculative decoding
flag, and a 32,768-token context instead of 65,536.

```bash
vllm serve "$HOME/vllm/models/RedHatAI/Qwen3.8-27B-INT4" \
  --served-model-name qwen3.8-27b-int4 --host 127.0.0.1 --port 8000 \
  --reasoning-parser qwen3 --enable-auto-tool-choice --tool-call-parser qwen3_xml \
  --structured-outputs-config '{"backend":"guidance"}' \
  --max-model-len 32768 --gpu-memory-utilization 0.78 --max-num-seqs 16 \
  --speculative-config '{"method":"mtp","num_speculative_tokens":3}'
```

The benchmark was the gated one with fewer levels and requests:

```bash
GRAPEVINE_LLM_RUNTIME=vllm python -m grapevine_llm.bench run --streams 1,4,16 --requests 24 --output bench/experiments/vllm-mtp.json
```

### Why not 65,536 tokens

With `--max-model-len 65536` and the same flag, vLLM 0.33.0 stops at startup:

```text
ValueError: To serve at least one request with the model's max seq len (65536), (3.06 GiB KV cache is needed, which is larger than the available KV cache memory (2.18 GiB). Based on the available memory, the estimated maximum model length is 36800.
```

What the engine reported at startup, with and without the flag, both at
`--gpu-memory-utilization 0.78` on the 32,607 MiB card:

| Reading                          | Committed flags | With speculative decoding |
| -------------------------------- | --------------- | ------------------------- |
| Consumed (weights and non-torch) | 17.79 GiB       | 18.62 GiB                 |
| Peak activation                  | 2.26 GiB        | 3.97 GiB                  |
| Available for the KV cache       | 4.76 GiB        | 2.23 GiB                  |
| KV cache size                    | 127,139 tokens  | 35,288 tokens             |

### What limited concurrency

vLLM's periodic log line during the run. The first three lines are the short prompt at
1, 4 and 16 streams, the last three the long prompt at the same levels:

```text
09:57:19 Running: 1 reqs, Waiting: 0 reqs, GPU KV cache usage: 31.7%
09:57:29 Running: 3 reqs, Waiting: 0 reqs, GPU KV cache usage: 95.1%
09:57:39 Running: 3 reqs, Waiting: 13 reqs, Deferred: 13 reqs, GPU KV cache usage: 95.1%
09:58:42 Running: 1 reqs, Waiting: 0 reqs, GPU KV cache usage: 36.6%
09:59:02 Running: 2 reqs, Waiting: 1 reqs, Deferred: 1 reqs, GPU KV cache usage: 70.7%
09:59:33 Running: 2 reqs, Waiting: 13 reqs, Deferred: 13 reqs, GPU KV cache usage: 70.7%
```

The levels are matched to the lines by elapsed time, since the benchmark does not log
when a level starts. One request holds about a third of the cache whether its prompt is
436 tokens or 4,058, so three short requests or two long ones run at once and the rest
wait. Why a single request takes that much was not traced.

Over the run the engine's speculative decoding line reported a mean acceptance length of
3.2 to 3.4 tokens and a draft acceptance rate of 74% to 82%.

### Not tuned

vLLM logged that it set `max_num_scheduled_tokens` to 2,048 for speculative decoding and
suggested raising `max_num_batched_tokens`. That was left at its default, and
`num_speculative_tokens` was left at the card's 3. A tuned configuration may do better
than these numbers at more than one stream.
