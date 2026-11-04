import "./deepeval-env.js";
import { readFile } from "node:fs/promises";
import { model_manifestSchema, vllm_manifestSchema } from "../llm/generated.js";
import { llmRuntime, runtimeVersion, VLLM_BASE_URL } from "../llm/runtime.js";
import { localTraceEndpoint } from "../offline.js";

const pinsPath = new URL("../../../llm/evals/models.json", import.meta.url);
const vllmPinsPath = new URL("../../../llm/evals/models.vllm.json", import.meta.url);
export function judgeModelName(): string {
  return llmRuntime() === "vllm" ? "qwen3.8-27b-int4" : "qwen3.8:27b";
}
export interface Judge {
  model: { name: string; baseUrl: string };
  name: string;
  baseUrl: string;
}
/** vLLM holds the GPU, so its judge is the same served model, checked against its own record. */
async function vllmJudge(): Promise<Judge> {
  const pins = vllm_manifestSchema.parse(JSON.parse(await readFile(vllmPinsPath, "utf8")));
  const baseUrl = process.env.GRAPEVINE_LLM_BASE_URL || VLLM_BASE_URL;
  if (!localTraceEndpoint(baseUrl)) throw new Error("Judge requires a loopback endpoint");
  const response = await fetch(`${baseUrl}/v1/models`, {
    redirect: "error",
    signal: AbortSignal.timeout(5000),
  });
  const served = (await response.json()) as { data?: { id: string; root?: string }[] };
  if (
    (await runtimeVersion(baseUrl, 5000)) !== pins.runtime_version ||
    !response.ok ||
    !served.data?.some((m) => m.id === pins.judge.name && m.root?.endsWith(pins.judge.repository))
  ) {
    throw new Error("Judge runtime or model differs from the reviewed manifest");
  }
  return { name: pins.judge.name, baseUrl, model: { name: pins.judge.name, baseUrl } };
}
export async function judge(): Promise<Judge> {
  if (llmRuntime() === "vllm") return vllmJudge();
  const pins = model_manifestSchema.parse(JSON.parse(await readFile(pinsPath, "utf8")));
  const baseUrl = process.env.GRAPEVINE_LLM_BASE_URL || "http://127.0.0.1:11434";
  if (!localTraceEndpoint(baseUrl)) throw new Error("Judge requires a loopback endpoint");
  const version = await fetch(`${baseUrl}/api/version`, {
    redirect: "error",
    signal: AbortSignal.timeout(5000),
  });
  const runtime = (await version.json()) as { version?: string };
  const response = await fetch(`${baseUrl}/api/tags`, {
    redirect: "error",
    signal: AbortSignal.timeout(5000),
  });
  const installed = (await response.json()) as { models?: { name: string; digest: string }[] };
  if (
    !version.ok ||
    runtime.version !== pins.runtime_version ||
    !response.ok ||
    !installed.models?.some((m) => m.name === pins.judge.name && m.digest === pins.judge.digest)
  ) {
    throw new Error("Judge runtime or model digest differs from the reviewed manifest");
  }
  return { name: pins.judge.name, baseUrl, model: { name: pins.judge.name, baseUrl } };
}
export async function judgeUnavailable(): Promise<string | null> {
  try {
    await judge();
    return null;
  } catch {
    return "Pinned local judge is unavailable or has changed";
  }
}
export const METRIC_DEFAULTS = {
  showIndicator: false,
  verboseMode: false,
  includeReason: true,
} as const;
