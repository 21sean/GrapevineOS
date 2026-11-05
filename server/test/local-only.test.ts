import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Hosted CLI generation is gone, but a row saved before v0.7.0 can still name a
 * CLI. It has to load, nothing may generate through it, nothing new may select
 * it, and the way back has to work.
 */
const state = vi.hoisted(() => ({
  saved: {} as Record<string, unknown>,
  patches: [] as unknown[],
  version: "0.20.0" as string | null,
  generateTyped: vi.fn(),
}));

vi.mock("../src/auth.js", () => ({
  requireAdmin: (_req: unknown, _res: unknown, next: () => void) => next(),
  sessionUser: async () => null,
}));
vi.mock("../src/store.js", () => ({
  store: {
    settings: async () => state.saved,
    saveSettings: async (patch: object) => {
      state.patches.push(patch);
      state.saved = { ...state.saved, ...patch };
      return state.saved;
    },
  },
}));
vi.mock("../src/ollama.js", () => ({
  ollamaBase: async () => "http://ollama.test",
  modelSupportsTools: async () => true,
}));
vi.mock("../src/mcp.js", () => ({ MCP_ENDPOINT: "/mcp", mcpAuthMode: () => "oauth" }));
vi.mock("../src/inbox.js", () => ({ inboxDomain: () => "" }));
vi.mock("../src/agent/guardrails.js", () => ({
  classifierReady: () => true,
  guardConfig: async () => ({ mode: "on", threshold: 0.8 }),
  invalidateGuardConfig: () => {},
}));
vi.mock("../src/llm/gateway.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/llm/gateway.js")>()),
  generateTyped: state.generateTyped,
}));

import { generateJSON } from "../src/llm.js";
import { VLLM_MODEL } from "../src/llm/runtime.js";
import { capabilities } from "../src/routes/capabilities.js";
import { providers } from "../src/routes/providers.js";
import { settings } from "../src/routes/settings.js";

const realFetch = globalThis.fetch;
let server: Server;
let base: string;

beforeAll(async () => {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith(base)) return realFetch(input, init);
    if (state.version === null) return new Response("", { status: 503 });
    return new Response(JSON.stringify({ version: state.version }), { status: 200 });
  });
  const app = express();
  app.use(express.json());
  app.use(settings, capabilities, providers);
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  vi.unstubAllGlobals();
  return new Promise((r) => server.close(r));
});
beforeEach(() => {
  state.saved = {
    city: "Testville",
    model: "test-model",
    chatProvider: "claude",
    extractProvider: "codex",
  };
  state.patches = [];
  state.version = "0.20.0";
  state.generateTyped.mockReset();
});
afterEach(() => vi.unstubAllEnvs());

const put = (body: unknown) =>
  fetch(`${base}/api/settings`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const getJson = async (path: string) => (await fetch(`${base}${path}`)).json();

describe("a CLI saved before v0.7.0", () => {
  it("still loads", async () => {
    expect(await getJson("/api/settings")).toMatchObject({
      chatProvider: "claude",
      extractProvider: "codex",
    });
  });

  it("can be changed back", async () => {
    const res = await put({ chatProvider: "ollama", extractProvider: "ollama" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ chatProvider: "ollama", extractProvider: "ollama" });
  });

  it("does not get in the way of saving anything else", async () => {
    const res = await put({ city: "Elsewhere" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ city: "Elsewhere", chatProvider: "claude" });
  });

  it("offers no tools and no model", async () => {
    expect(await getJson("/api/agent/capabilities")).toMatchObject({
      provider: "claude",
      model: "",
      tools: false,
      toolbox: [],
    });
  });

  it("is refused for extraction before the gate", async () => {
    await expect(
      generateJSON({ task: "extraction", system: "s", user: "u" }),
    ).rejects.toMatchObject({ code: "unsupported_provider" });
    expect(state.generateTyped).not.toHaveBeenCalled();
  });
});

describe("selecting a provider", () => {
  it.each(["claude", "codex", "gemini", "copilot", "made-up"])("refuses %s", async (id) => {
    expect((await put({ chatProvider: id })).status).toBe(400);
    expect((await put({ extractProvider: id })).status).toBe(400);
    expect(state.patches).toEqual([]);
  });
});

describe("on the local runtime", () => {
  beforeEach(() => {
    state.saved = { ...state.saved, chatProvider: "ollama", extractProvider: "ollama" };
  });

  it("generates through the gate", async () => {
    state.generateTyped.mockResolvedValueOnce({ events: [] });
    await generateJSON({ task: "extraction", system: "s", user: "u" });
    expect(state.generateTyped).toHaveBeenCalledOnce();
  });

  it("gives the model the graph's toolbox", async () => {
    const caps = await getJson("/api/agent/capabilities");
    expect(caps).toMatchObject({ provider: "ollama", model: "test-model", tools: true });
    expect(caps.toolbox.length).toBeGreaterThan(0);
  });

  it("reports the runtime that serves it", async () => {
    expect(await getJson("/api/runtime")).toEqual({
      id: "ollama",
      name: "Ollama",
      url: "http://ollama.test",
      version: "0.20.0",
      model: "test-model",
    });
  });

  it("says so when the runtime does not answer", async () => {
    state.version = null;
    expect(await getJson("/api/runtime")).toMatchObject({ name: "Ollama", version: null });
  });

  it("reports vLLM and its pinned model when that is the runtime", async () => {
    vi.stubEnv("GRAPEVINE_LLM_RUNTIME", "vllm");
    vi.stubEnv("GRAPEVINE_LLM_MODEL", "");
    expect(await getJson("/api/runtime")).toMatchObject({
      id: "vllm",
      name: "vLLM",
      model: VLLM_MODEL,
    });
  });
});
