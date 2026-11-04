/**
 * Which local runtime serves structured inference. Ollama is the default; vLLM
 * is an opt-in beside it, chosen with GRAPEVINE_LLM_RUNTIME. The Python worker
 * inherits the same variables, so both sides always agree.
 *
 * Ollama helpers load on demand: they read the settings store, which the
 * offline eval process must not import.
 */

export type LlmRuntime = "ollama" | "vllm";

export const VLLM_BASE_URL = "http://127.0.0.1:8000";
export const VLLM_MODEL = "qwen3.8-27b-int4";

/** An unknown value stops the request: a typo must not silently pick a runtime. */
export function llmRuntime(): LlmRuntime {
  const value = process.env.GRAPEVINE_LLM_RUNTIME ?? "ollama";
  if (value === "ollama" || value === "vllm") return value;
  throw new Error(`GRAPEVINE_LLM_RUNTIME must be ollama or vllm, got ${value}`);
}

export function runtimeLabel(runtime: LlmRuntime = llmRuntime()): string {
  return runtime === "vllm" ? "vLLM" : "Ollama";
}

function vllmBase(): string {
  return (process.env.GRAPEVINE_LLM_BASE_URL || VLLM_BASE_URL).replace(/\/$/, "");
}

/** Base URL of the active runtime. */
export async function llmBase(): Promise<string> {
  if (llmRuntime() === "vllm") return vllmBase();
  return (await import("../ollama.js")).ollamaBase();
}

/** vLLM serves one pinned model, so the Ollama tag picked in Admin does not apply to it. */
export function llmModel(selected: string): string {
  return llmRuntime() === "vllm" ? process.env.GRAPEVINE_LLM_MODEL || VLLM_MODEL : selected;
}

/** The runtime's version string, or null when it does not answer. */
export async function runtimeVersion(baseUrl: string, timeoutMs = 3000): Promise<string | null> {
  const path = llmRuntime() === "vllm" ? "/version" : "/api/version";
  const response = await fetch(`${baseUrl}${path}`, {
    signal: AbortSignal.timeout(timeoutMs),
  }).catch(() => null);
  if (!response?.ok) return null;
  const body = (await response.json().catch(() => ({}))) as { version?: string };
  return body.version ?? "unknown";
}

/**
 * Tool requests are part of the agent's JSON Schema output, so any served model
 * that takes constrained decoding can use them. vLLM only has to be serving it.
 */
export async function runtimeSupportsTools(model: string): Promise<boolean> {
  if (llmRuntime() !== "vllm") return (await import("../ollama.js")).modelSupportsTools(model);
  const response = await fetch(`${vllmBase()}/v1/models`, {
    signal: AbortSignal.timeout(3000),
  }).catch(() => null);
  if (!response?.ok) return false;
  const body = (await response.json().catch(() => ({}))) as { data?: { id: string }[] };
  return (body.data ?? []).some((served) => served.id === model);
}
