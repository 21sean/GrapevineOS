/**
 * Which local runtime serves structured inference. Ollama is the default; vLLM and
 * NVIDIA Triton (serving the same vLLM engine) are opt-ins beside it, chosen with
 * GRAPEVINE_LLM_RUNTIME. The Python worker inherits the same variables, so both
 * sides always agree.
 *
 * Ollama helpers load on demand: they read the settings store, which the
 * offline eval process must not import.
 */

export type LlmRuntime = "ollama" | "vllm" | "triton";

export const VLLM_BASE_URL = "http://127.0.0.1:8000";
export const VLLM_MODEL = "qwen3.8-27b-int4";
/** Triton's OpenAI-compatible frontend. Its KServe endpoint reports the server version. */
export const TRITON_BASE_URL = "http://127.0.0.1:9000";
export const TRITON_KSERVE_URL = "http://127.0.0.1:9001";
/** Triton serves the checkpoint vLLM serves, under the same name. */
export const TRITON_MODEL = VLLM_MODEL;

const RUNTIMES: readonly LlmRuntime[] = ["ollama", "vllm", "triton"];
const LABELS: Record<LlmRuntime, string> = { ollama: "Ollama", vllm: "vLLM", triton: "Triton" };

/** An unknown value stops the request: a typo must not silently pick a runtime. */
export function llmRuntime(): LlmRuntime {
  const value = process.env.GRAPEVINE_LLM_RUNTIME ?? "ollama";
  if ((RUNTIMES as readonly string[]).includes(value)) return value as LlmRuntime;
  throw new Error(`GRAPEVINE_LLM_RUNTIME must be ollama, vllm or triton, got ${value}`);
}

export function runtimeLabel(runtime: LlmRuntime = llmRuntime()): string {
  return LABELS[runtime];
}

/** vLLM and Triton serve one pinned model at a fixed address; Ollama's come from Admin. */
export function servesPinnedModel(runtime: LlmRuntime = llmRuntime()): boolean {
  return runtime !== "ollama";
}

function pinnedBase(runtime: LlmRuntime): string {
  const fallback = runtime === "triton" ? TRITON_BASE_URL : VLLM_BASE_URL;
  return (process.env.GRAPEVINE_LLM_BASE_URL || fallback).replace(/\/$/, "");
}

function tritonKserve(): string {
  return (process.env.GRAPEVINE_TRITON_KSERVE_URL || TRITON_KSERVE_URL).replace(/\/$/, "");
}

/** Base URL of the active runtime. */
export async function llmBase(): Promise<string> {
  const runtime = llmRuntime();
  if (servesPinnedModel(runtime)) return pinnedBase(runtime);
  return (await import("../ollama.js")).ollamaBase();
}

/** A pinned runtime serves one model, so the Ollama tag picked in Admin does not apply to it. */
export function llmModel(selected: string): string {
  const runtime = llmRuntime();
  if (!servesPinnedModel(runtime)) return selected;
  return process.env.GRAPEVINE_LLM_MODEL || (runtime === "triton" ? TRITON_MODEL : VLLM_MODEL);
}

async function versionAt(url: string, timeoutMs: number): Promise<string | null> {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) }).catch(() => null);
  if (!response?.ok) return null;
  const body = (await response.json().catch(() => ({}))) as { version?: string };
  return body.version ?? "unknown";
}

/** The runtime's version string, or null when it does not answer. */
export async function runtimeVersion(baseUrl: string, timeoutMs = 3000): Promise<string | null> {
  const runtime = llmRuntime();
  if (runtime === "ollama") return versionAt(`${baseUrl}/api/version`, timeoutMs);
  if (runtime === "vllm") return versionAt(`${baseUrl}/version`, timeoutMs);
  // Triton's OpenAI frontend has no version route. Its KServe endpoint names the
  // server version; without that endpoint, readiness still says the runtime is up.
  const ready = await fetch(`${baseUrl}/health/ready`, {
    signal: AbortSignal.timeout(timeoutMs),
  }).catch(() => null);
  if (!ready?.ok) return null;
  return (await versionAt(`${tritonKserve()}/v2`, timeoutMs)) ?? "unknown";
}

/**
 * Tool requests are part of the agent's JSON Schema output, so any served model
 * that takes constrained decoding can use them. A pinned runtime only has to be
 * serving it.
 */
export async function runtimeSupportsTools(model: string): Promise<boolean> {
  const runtime = llmRuntime();
  if (!servesPinnedModel(runtime)) return (await import("../ollama.js")).modelSupportsTools(model);
  const response = await fetch(`${pinnedBase(runtime)}/v1/models`, {
    signal: AbortSignal.timeout(3000),
  }).catch(() => null);
  if (!response?.ok) return false;
  const body = (await response.json().catch(() => ({}))) as { data?: { id: string }[] };
  return (body.data ?? []).some((served) => served.id === model);
}
