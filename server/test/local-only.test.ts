import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/** Provider settings, routing and local-runtime compatibility. */
const state = vi.hoisted(() => ({
  saved: {} as Record<string, unknown>,
  patches: [] as unknown[],
  version: "0.20.0" as string | null,
  generateTyped: vi.fn(),
  runHostedWorker: vi.fn(),
  admin: true,
}));

vi.mock("../src/auth.js", () => ({
  requireAdmin: (_req: unknown, res: express.Response, next: () => void) =>
    state.admin ? next() : res.status(403).json({ error: "admin required" }),
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
vi.mock("../src/llm/hosted.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/llm/hosted.js")>()),
  runHostedWorker: state.runHostedWorker,
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
  state.runHostedWorker.mockReset();
  state.admin = true;
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

  it("offers the hosted model and the validated graph toolbox", async () => {
    expect(await getJson("/api/agent/capabilities")).toMatchObject({
      provider: "claude",
      model: "best",
      tools: true,
    });
  });

  it("routes extraction through the same gate with its own hosted model", async () => {
    await generateJSON({ task: "extraction", system: "s", user: "u" });
    expect(state.generateTyped).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "codex",
        model: "gpt-6-astra",
        task: "extraction",
        baseUrl: undefined,
      }),
    );
  });
});

describe("selecting a provider", () => {
  it.each(["gemini", "copilot", "made-up"])("refuses %s", async (id) => {
    expect((await put({ chatProvider: id })).status).toBe(400);
    expect((await put({ extractProvider: id })).status).toBe(400);
    expect(state.patches).toEqual([]);
  });
  it.each(["claude", "codex", "ollama"])("accepts %s independently for each role", async (id) => {
    expect((await put({ chatProvider: id })).status).toBe(200);
    expect((await put({ extractProvider: id })).status).toBe(200);
    expect(state.patches).toEqual([{ chatProvider: id }, { extractProvider: id }]);
  });
});

describe("hosted setup endpoints", () => {
  it("adds the configured model to authentication diagnostics", async () => {
    state.runHostedWorker.mockResolvedValue(
      JSON.stringify([{ id: "codex", ready: true, version: "test", message: "Signed in" }]),
    );
    vi.stubEnv("GRAPEVINE_CODEX_MODEL", "custom-current-model");
    expect(await getJson("/api/providers")).toEqual([
      {
        id: "codex",
        ready: true,
        version: "test",
        message: "Signed in",
        model: "custom-current-model",
      },
    ]);
  });

  it("uses a real generation path for the explicit connection test", async () => {
    state.generateTyped.mockResolvedValue({ summary: "Connected" });
    const response = await fetch(`${base}/api/providers/claude/test`, { method: "POST" });
    expect(response.status).toBe(200);
    expect(state.generateTyped).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "claude", model: "best", task: "summary" }),
    );
  });

  it("requires admin before reading status or spending provider quota", async () => {
    state.admin = false;
    expect((await fetch(`${base}/api/providers`)).status).toBe(403);
    expect((await fetch(`${base}/api/providers/codex/test`, { method: "POST" })).status).toBe(403);
    expect(state.runHostedWorker).not.toHaveBeenCalled();
    expect(state.generateTyped).not.toHaveBeenCalled();
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
