/**
 * Admission control for background work: may another extraction or grading job start
 * now, judged from what the runtime and the GPU report about themselves.
 *
 * Three signals, each read from the place that owns it:
 *
 *  - the runtime's own queue. vLLM counts the requests it is holding back, and Triton
 *    counts the ones pending on a model. If the runtime is already queueing, more
 *    background work only lengthens the wait for the next chat turn.
 *  - KV cache use. Every running sequence holds cache blocks, and a long newsletter
 *    holds many. Near the ceiling the runtime starts preempting its own sequences.
 *    Only vLLM serves this gauge: Triton's vLLM backend republishes token counts and
 *    latency histograms, not the queue or cache gauges, and Ollama has no such metric.
 *  - free GPU memory, only where a generation may have to load the model first. vLLM
 *    and Triton reserve their memory at start, so free VRAM says nothing once they
 *    are up. Ollama loads on demand: if the model is not resident and will not fit in
 *    what is free, a background job would evict something or fail, so it waits.
 *
 * A signal the runtime does not report is skipped, never guessed: an unknown reading
 * admits. Interactive work is not gated here at all (see scheduler.ts).
 */
import { execFile } from "node:child_process";
import { llmRuntime, type LlmRuntime } from "./runtime.js";

export interface Load {
  /** Requests the runtime is generating. */
  running: number | null;
  /** Requests the runtime is holding in its own queue. */
  waiting: number | null;
  /** Share of the KV cache in use, 0 to 1. */
  kvCacheUsage: number | null;
  /** Free VRAM in MiB. */
  gpuFreeMiB: number | null;
  /** MiB a generation would have to load first; 0 when the model is resident. */
  coldLoadMiB: number | null;
}

export type DeferReason = "runtime-queue" | "kv-cache" | "gpu-memory";
export type Admission = { admitted: true } | { admitted: false; reason: DeferReason };

export interface Thresholds {
  maxWaiting: number;
  kvCacheUsage: number;
  vramHeadroomMiB: number;
}

export interface Target {
  baseUrl: string;
  model: string;
}

const UNKNOWN: Load = {
  running: null,
  waiting: null,
  kvCacheUsage: null,
  gpuFreeMiB: null,
  coldLoadMiB: null,
};

function envNumber(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return process.env[name] && Number.isFinite(value) && value >= 0 ? value : fallback;
}

export function thresholds(): Thresholds {
  return {
    maxWaiting: envNumber("GRAPEVINE_LLM_ADMIT_MAX_WAITING", 0),
    kvCacheUsage: envNumber("GRAPEVINE_LLM_ADMIT_KV_CACHE", 0.85),
    vramHeadroomMiB: envNumber("GRAPEVINE_LLM_ADMIT_VRAM_HEADROOM_MB", 1024),
  };
}

/** The policy itself, with no I/O. */
export function decide(load: Load, limits: Thresholds = thresholds()): Admission {
  if (load.waiting !== null && load.waiting > limits.maxWaiting)
    return { admitted: false, reason: "runtime-queue" };
  if (load.kvCacheUsage !== null && load.kvCacheUsage >= limits.kvCacheUsage)
    return { admitted: false, reason: "kv-cache" };
  if (
    load.coldLoadMiB !== null &&
    load.coldLoadMiB > 0 &&
    load.gpuFreeMiB !== null &&
    load.gpuFreeMiB < load.coldLoadMiB + limits.vramHeadroomMiB
  )
    return { admitted: false, reason: "gpu-memory" };
  return { admitted: true };
}

/** Sum of every series of a Prometheus metric, or null when it is absent. */
export function metricSum(text: string, ...names: string[]): number | null {
  let sum: number | null = null;
  for (const line of text.split("\n")) {
    if (!line || line[0] === "#") continue;
    const match = /^([A-Za-z_:][\w:]*)(?:\{[^}]*\})?\s+(\S+)/.exec(line);
    if (!match || !names.includes(match[1])) continue;
    const value = Number(match[2]);
    if (Number.isFinite(value)) sum = (sum ?? 0) + value;
  }
  return sum;
}

async function text(url: string): Promise<string | null> {
  const response = await fetch(url, { signal: AbortSignal.timeout(1500) }).catch(() => null);
  return response?.ok ? response.text().catch(() => null) : null;
}

/** vLLM's own counters. */
function fromVllmMetrics(body: string | null): Load {
  if (body === null) return UNKNOWN;
  return {
    ...UNKNOWN,
    running: metricSum(body, "vllm:num_requests_running"),
    waiting: metricSum(body, "vllm:num_requests_waiting"),
    // Renamed from gpu_cache_usage_perc; an older engine inside a container still uses it.
    kvCacheUsage: metricSum(body, "vllm:kv_cache_usage_perc", "vllm:gpu_cache_usage_perc"),
  };
}

function gpuFreeMiB(): Promise<number | null> {
  return new Promise((resolve) => {
    execFile(
      "nvidia-smi",
      ["--query-gpu=memory.free", "--format=csv,noheader,nounits"],
      { timeout: 3000, windowsHide: true },
      (error, stdout) => {
        const free = Number(String(stdout).trim().split(/\r?\n/)[0]);
        resolve(error || !Number.isFinite(free) ? null : free);
      },
    );
  });
}

async function fromOllama(target: Target): Promise<Load> {
  const json = async (path: string) => {
    const body = await text(`${target.baseUrl}${path}`);
    try {
      return body === null ? null : (JSON.parse(body) as { models?: Record<string, unknown>[] });
    } catch {
      return null;
    }
  };
  const loaded = await json("/api/ps");
  if (!loaded) return UNKNOWN;
  const resident = (loaded.models ?? []).some((m) => m.name === target.model);
  if (resident) return { ...UNKNOWN, running: null, coldLoadMiB: 0 };
  const installed = await json("/api/tags");
  const size = (installed?.models ?? []).find((m) => m.name === target.model)?.size;
  return {
    ...UNKNOWN,
    gpuFreeMiB: await gpuFreeMiB(),
    // The file size is a floor for what the load needs: the context comes on top.
    coldLoadMiB: typeof size === "number" ? Math.ceil(size / 1_048_576) : null,
  };
}

/** Triton's core counter for requests accepted but not yet executing. */
function fromTritonMetrics(body: string | null): Load {
  if (body === null) return UNKNOWN;
  return { ...UNKNOWN, waiting: metricSum(body, "nv_inference_pending_request_count") };
}

/** What the active runtime reports right now. Never throws. */
export async function probe(target: Target, runtime: LlmRuntime = llmRuntime()): Promise<Load> {
  try {
    if (runtime === "vllm") return fromVllmMetrics(await text(`${target.baseUrl}/metrics`));
    if (runtime === "triton") return fromTritonMetrics(await text(`${target.baseUrl}/metrics`));
    return await fromOllama(target);
  } catch {
    return UNKNOWN;
  }
}

/** How long one reading is trusted. Load moves in tens of milliseconds; this is a brake, not a meter. */
const FRESH_MS = 1000;

type Probe = (target: Target) => Promise<Load>;
let reader: Probe = (target) => probe(target);
let last: { at: number; admission: Admission; load: Load } | null = null;
let refreshing: Promise<void> | null = null;

/** Replace the probe. For tests. */
export function setProbe(next: Probe | null): void {
  reader = next ?? ((target) => probe(target));
  last = null;
  refreshing = null;
}

export function admissionEnabled(): boolean {
  return process.env.GRAPEVINE_LLM_ADMISSION !== "off";
}

/**
 * The current answer for background work, without waiting. `stale` means the reading
 * is old or missing: the caller holds background work, calls refresh(), and asks again.
 */
export function backgroundAdmission(now = Date.now()): { admission: Admission; stale: boolean } {
  if (!admissionEnabled()) return { admission: { admitted: true }, stale: false };
  if (!last) return { admission: { admitted: false, reason: "runtime-queue" }, stale: true };
  return { admission: last.admission, stale: now - last.at >= FRESH_MS };
}

/** Take a new reading. Concurrent callers share one probe. */
export function refresh(target: Target): Promise<void> {
  refreshing ??= reader(target)
    .catch(() => UNKNOWN)
    .then((load) => {
      last = { at: Date.now(), admission: decide(load), load };
      refreshing = null;
    });
  return refreshing;
}

/** The last reading, for the health route. */
export function lastLoad(): (Load & { admitted: boolean; reason?: DeferReason }) | null {
  if (!last) return null;
  return {
    ...last.load,
    admitted: last.admission.admitted,
    ...(!last.admission.admitted && { reason: last.admission.reason }),
  };
}
