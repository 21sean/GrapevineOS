import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { llmModel, llmRuntime, runtimeLabel, VLLM_MODEL } from "../src/llm/runtime.js";

const saved = { ...process.env };

beforeEach(() => {
  delete process.env.GRAPEVINE_LLM_RUNTIME;
  delete process.env.GRAPEVINE_LLM_MODEL;
  delete process.env.GRAPEVINE_LLM_BASE_URL;
});
afterEach(() => {
  process.env = { ...saved };
  vi.unstubAllGlobals();
});

it("defaults to Ollama and keeps the model picked in Admin", () => {
  expect(llmRuntime()).toBe("ollama");
  expect(runtimeLabel()).toBe("Ollama");
  expect(llmModel("qwen3.8:27b")).toBe("qwen3.8:27b");
});

it("uses the pinned served name under vLLM, whatever Admin selected", () => {
  process.env.GRAPEVINE_LLM_RUNTIME = "vllm";
  expect(runtimeLabel()).toBe("vLLM");
  expect(llmModel("qwen3.8:27b")).toBe(VLLM_MODEL);
  process.env.GRAPEVINE_LLM_MODEL = "another-served-name";
  expect(llmModel("qwen3.8:27b")).toBe("another-served-name");
});

it("refuses an unknown runtime instead of guessing", () => {
  process.env.GRAPEVINE_LLM_RUNTIME = "openai";
  expect(() => llmRuntime()).toThrow(/ollama or vllm/);
});

it("reads the vLLM version, health and served model from its own endpoints", async () => {
  process.env.GRAPEVINE_LLM_RUNTIME = "vllm";
  const paths: string[] = [];
  vi.stubGlobal("fetch", async (url: string) => {
    paths.push(new URL(url).pathname);
    return new Response(
      JSON.stringify(
        url.endsWith("/version") ? { version: "0.33.0" } : { data: [{ id: VLLM_MODEL }] },
      ),
    );
  });
  const { llmBase, runtimeSupportsTools, runtimeVersion } = await import("../src/llm/runtime.js");
  expect(await llmBase()).toBe("http://127.0.0.1:8000");
  expect(await runtimeVersion("http://127.0.0.1:8000")).toBe("0.33.0");
  expect(await runtimeSupportsTools(VLLM_MODEL)).toBe(true);
  expect(await runtimeSupportsTools("something-else")).toBe(false);
  expect(paths).toEqual(["/version", "/v1/models", "/v1/models"]);
});

it("reports a stopped runtime as null, not as a thrown error", async () => {
  process.env.GRAPEVINE_LLM_RUNTIME = "vllm";
  vi.stubGlobal("fetch", async () => {
    throw new Error("connection refused");
  });
  const { runtimeSupportsTools, runtimeVersion } = await import("../src/llm/runtime.js");
  expect(await runtimeVersion("http://127.0.0.1:8000")).toBeNull();
  expect(await runtimeSupportsTools(VLLM_MODEL)).toBe(false);
});
