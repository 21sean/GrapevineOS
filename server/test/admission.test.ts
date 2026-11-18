import { afterEach, expect, it, vi } from "vitest";
import { decide, metricSum, probe, type Load } from "../src/llm/admission.js";

const unknown: Load = {
  running: null,
  waiting: null,
  kvCacheUsage: null,
  gpuFreeMiB: null,
  coldLoadMiB: null,
};
const limits = { maxWaiting: 0, kvCacheUsage: 0.85, vramHeadroomMiB: 1024 };
const target = { baseUrl: "http://127.0.0.1:8000", model: "qwen3.8-27b-int4" };

afterEach(() => vi.unstubAllGlobals());

it("admits when the runtime reports nothing: an unknown reading is not a refusal", () => {
  expect(decide(unknown, limits)).toEqual({ admitted: true });
});

it("defers background work on the runtime's own queue, its KV cache, and a cold load that will not fit", () => {
  expect(decide({ ...unknown, waiting: 1 }, limits)).toEqual({
    admitted: false,
    reason: "runtime-queue",
  });
  expect(decide({ ...unknown, kvCacheUsage: 0.85 }, limits)).toEqual({
    admitted: false,
    reason: "kv-cache",
  });
  expect(decide({ ...unknown, kvCacheUsage: 0.84 }, limits)).toEqual({ admitted: true });
  // 16 GB to load, 16.5 GB free: under the 1 GiB headroom.
  expect(decide({ ...unknown, coldLoadMiB: 16_384, gpuFreeMiB: 16_900 }, limits)).toEqual({
    admitted: false,
    reason: "gpu-memory",
  });
  expect(decide({ ...unknown, coldLoadMiB: 16_384, gpuFreeMiB: 20_000 }, limits)).toEqual({
    admitted: true,
  });
  // A resident model needs no memory, however little is free.
  expect(decide({ ...unknown, coldLoadMiB: 0, gpuFreeMiB: 100 }, limits)).toEqual({
    admitted: true,
  });
});

it("sums a Prometheus metric across its series and reports an absent one as unknown", () => {
  const body = [
    "# HELP vllm:num_requests_waiting Number of requests waiting to be processed.",
    "# TYPE vllm:num_requests_waiting gauge",
    'vllm:num_requests_waiting{engine="0",model_name="a"} 2.0',
    'vllm:num_requests_waiting{engine="0",model_name="b"} 1.0',
    'vllm:kv_cache_usage_perc{engine="0",model_name="a"} 0.25',
    "vllm:num_requests_waiting_by_reason 9",
  ].join("\n");
  expect(metricSum(body, "vllm:num_requests_waiting")).toBe(3);
  expect(metricSum(body, "vllm:kv_cache_usage_perc", "vllm:gpu_cache_usage_perc")).toBe(0.25);
  expect(metricSum(body, "vllm:num_requests_running")).toBeNull();
});

it("reads vLLM's queue and KV cache from its metrics endpoint", async () => {
  const seen: string[] = [];
  vi.stubGlobal("fetch", async (url: string) => {
    seen.push(url);
    return new Response(
      'vllm:num_requests_running{model_name="m"} 4\nvllm:num_requests_waiting{model_name="m"} 0\nvllm:kv_cache_usage_perc{model_name="m"} 0.31\n',
    );
  });
  expect(await probe(target, "vllm")).toEqual({
    ...unknown,
    running: 4,
    waiting: 0,
    kvCacheUsage: 0.31,
  });
  expect(seen).toEqual(["http://127.0.0.1:8000/metrics"]);
});

it("reads only Triton's pending count, because Triton republishes no cache gauge", async () => {
  vi.stubGlobal(
    "fetch",
    async () =>
      new Response(
        'nv_inference_pending_request_count{model="m",version="1"} 2\nvllm:prompt_tokens_total{model="m",version="1"} 900\n',
      ),
  );
  expect(await probe({ ...target, baseUrl: "http://127.0.0.1:9000" }, "triton")).toEqual({
    ...unknown,
    waiting: 2,
  });
});

it("asks Ollama whether the model is resident before counting on free memory", async () => {
  vi.stubGlobal("fetch", async (url: string) =>
    url.endsWith("/api/ps")
      ? new Response(JSON.stringify({ models: [{ name: "qwen3.8:27b", size_vram: 17e9 }] }))
      : new Response("{}", { status: 500 }),
  );
  const resident = await probe(
    { baseUrl: "http://127.0.0.1:11434", model: "qwen3.8:27b" },
    "ollama",
  );
  expect(resident.coldLoadMiB).toBe(0);
});

it("treats a runtime that does not answer as unknown rather than throwing", async () => {
  vi.stubGlobal("fetch", async () => {
    throw new Error("connection refused");
  });
  expect(await probe(target, "vllm")).toEqual(unknown);
  expect(await probe(target, "triton")).toEqual(unknown);
  expect(await probe(target, "ollama")).toEqual(unknown);
});
