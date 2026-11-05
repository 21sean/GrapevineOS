import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentFrame } from "../src/types.js";

/**
 * The real graph and the real chat route with the model faked at the gate: what
 * a person is shown as the answer generates, and what happens to it when the
 * answer fails validation, trips the persona rail, or nobody is left to read it.
 */
type GateOptions = {
  signal?: AbortSignal;
  onDelta?: (text: string) => void;
  onReset?: () => void;
};
const gate = vi.hoisted(() => ({
  generateTyped: vi.fn<(opts: GateOptions) => Promise<unknown>>(),
}));
vi.mock("../src/llm/gateway.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/llm/gateway.js")>()),
  generateTyped: gate.generateTyped,
}));
const seen = vi.hoisted(() => ({ appended: [] as unknown[][] }));
vi.mock("../src/auth.js", () => ({
  sessionUser: async () => ({
    id: "user-1",
    email: "u@example.com",
    name: "U",
    picture: "",
    createdAt: "",
    lastLoginAt: "",
  }),
}));
vi.mock("../src/store.js", () => {
  const settings = {
    city: "Testville",
    center: [0, 0],
    tz: "UTC",
    model: "test-model",
    ollamaUrl: "",
    chatProvider: "ollama",
    extractProvider: "ollama",
    guardMode: "off",
    guardThreshold: 0.8,
  };
  return {
    store: {
      settings: async () => settings,
      events: async () => [],
      chatThreadOwner: async () => null,
      appendChatTurn: async (...args: unknown[]) => {
        seen.appended.push(args);
      },
    },
  };
});
vi.mock("../src/ollama.js", () => ({
  ollamaBase: async () => "http://127.0.0.1:1",
  modelSupportsTools: async () => true,
}));
vi.mock("../src/checkpointer.js", async () => {
  const { MemorySaver } = await import("@langchain/langgraph");
  return { SupabaseSaver: MemorySaver };
});
vi.mock("../src/langfuse.js", () => ({
  langfuseHandler: () => null,
  recordLatencyScores: () => {},
  recordRailScore: () => {},
}));

import { LlmGateError } from "../src/llm/gateway.js";
import { chat } from "../src/agent/chat.js";

let server: Server;
let url: string;
const realFetch = globalThis.fetch;

beforeEach(async () => {
  gate.generateTyped.mockReset();
  seen.appended.length = 0;
  // The route checks the daemon is up before it builds the graph.
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
    String(input).includes("/api/version")
      ? new Response("{}", { status: 200 })
      : realFetch(input, init)) as typeof fetch;
  const app = express();
  app.use(express.json());
  app.use(chat);
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/agent/chat`;
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
});

const answer = (text: string) => ({
  kind: "insufficient_evidence",
  answer: text,
  citations: [],
  tool_calls: [],
});

async function turn(message = "hello"): Promise<AgentFrame[]> {
  const res = await realFetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message }),
  });
  const text = await res.text();
  return text
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as AgentFrame);
}

const shownText = (frames: AgentFrame[]) => {
  let text = "";
  for (const f of frames) {
    if (f.type === "delta") text += f.text;
    if (f.type === "replace") text = f.text;
  }
  return text;
};

/** Read a live response until a delta frame shows up, and return all it read so far. */
async function untilDelta(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  let text = "";
  while (!text.includes('"type":"delta"')) {
    const { done, value } = await reader.read();
    if (done) break;
    text += new TextDecoder().decode(value);
  }
  return text;
}

const LONG =
  "The jazz set at the shell starts at six and the market on Newport runs until eight tonight.";

describe("the answer as it generates", () => {
  it("reaches the client before the gate has finished, and matches the record", async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    gate.generateTyped.mockImplementationOnce(async (opts) => {
      for (const word of LONG.split(/(?<= )/)) opts.onDelta?.(word);
      await held;
      return answer(LONG);
    });
    const res = await realFetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "what is on?" }),
    });
    const reader = res.body!.getReader();
    // The gate is still holding the validated result, and text is already here.
    let rest = await untilDelta(reader);
    expect(rest).toContain('"type":"delta"');
    release();
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      rest += new TextDecoder().decode(next.value);
    }
    const frames = rest
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as AgentFrame);
    expect(shownText(frames)).toBe(LONG);
    expect(frames.some((f) => f.type === "replace")).toBe(false);
    await vi.waitFor(() => expect(seen.appended).toHaveLength(1));
    expect(seen.appended[0][3]).toMatchObject({ assistantText: LONG });
  });

  it("holds back the persona rail's window, so a short answer arrives whole at the end", async () => {
    gate.generateTyped.mockImplementationOnce(async (opts) => {
      opts.onDelta?.("Sure, ");
      opts.onDelta?.("the market.");
      return answer("Sure, the market.");
    });
    const frames = await turn();
    expect(shownText(frames)).toBe("Sure, the market.");
  });

  it("retracts a leak the moment the rail sees it, and drops the rest of the stream", async () => {
    const after: string[] = [];
    gate.generateTyped.mockImplementationOnce(async (opts) => {
      opts.onDelta?.(`${LONG} `);
      opts.onDelta?.("Honestly, I am Qwen, a large language model ");
      after.push("streamed past the trip");
      opts.onDelta?.("from a lab, and here is more of it to keep going for a while yet.");
      return answer(`${LONG} Honestly, I am Qwen, a large language model from a lab.`);
    });
    const frames = await turn();
    const replaces = frames.filter((f) => f.type === "replace");
    expect(replaces).toHaveLength(1);
    expect(shownText(frames)).toContain("Grapevine");
    expect(shownText(frames)).not.toMatch(/qwen/i);
    expect(frames.some((f) => f.type === "guardrail" && f.rail === "output")).toBe(true);
    await vi.waitFor(() => expect(seen.appended).toHaveLength(1));
    expect(JSON.stringify(seen.appended[0])).not.toMatch(/qwen/i);
  });

  it("takes back a failed attempt and shows only the repair", async () => {
    gate.generateTyped.mockImplementationOnce(async (opts) => {
      opts.onDelta?.(`Wrong first attempt, and long enough to clear the window. ${LONG}`);
      opts.onReset?.();
      opts.onDelta?.(LONG);
      return answer(LONG);
    });
    const frames = await turn();
    const firstDelta = frames.findIndex((f) => f.type === "delta");
    const reset = frames.findIndex((f) => f.type === "replace" && f.text === "");
    expect(firstDelta).toBeGreaterThanOrEqual(0);
    expect(reset).toBeGreaterThan(firstDelta);
    expect(shownText(frames)).toBe(LONG);
  });

  it("leaves no unvalidated text standing when every attempt fails", async () => {
    gate.generateTyped.mockImplementationOnce(async (opts) => {
      opts.onDelta?.(`This never validates, and the person saw it. ${LONG}`);
      throw new LlmGateError("validation_exhausted", "Model output did not satisfy the contract");
    });
    const frames = await turn();
    expect(frames.some((f) => f.type === "delta")).toBe(true);
    expect(shownText(frames)).not.toContain("This never validates");
    expect(shownText(frames)).toContain("reliable answer");
    expect(frames.some((f) => f.type === "replace")).toBe(true);
    await new Promise((r) => setTimeout(r, 20));
    expect(JSON.stringify(seen.appended)).not.toContain("This never validates");
    expect(seen.appended[0][3]).toMatchObject({
      assistantText: expect.stringContaining("reliable"),
    });
  });

  it("retracts when the runtime dies mid-answer too", async () => {
    gate.generateTyped.mockImplementationOnce(async (opts) => {
      opts.onDelta?.(`Half an answer that goes on long enough to be shown. ${LONG}`);
      throw new LlmGateError("transport", "Local model transport failed");
    });
    const frames = await turn();
    expect(shownText(frames)).toBe("");
    expect(frames.at(-1)?.type).toBe("error");
    await new Promise((r) => setTimeout(r, 20));
    expect(seen.appended).toHaveLength(0);
  });

  it("stops the model and records nothing when the client hangs up mid-answer", async () => {
    let signal: AbortSignal | undefined;
    gate.generateTyped.mockImplementationOnce(async (opts) => {
      signal = opts.signal;
      opts.onDelta?.(`Text the person saw before they closed the tab. ${LONG}`);
      await new Promise<void>((resolve) =>
        opts.signal?.addEventListener("abort", () => resolve(), { once: true }),
      );
      throw new LlmGateError("cancelled", "LLM request cancelled");
    });
    const ac = new AbortController();
    const res = await realFetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "what is on?" }),
      signal: ac.signal,
    });
    expect(await untilDelta(res.body!.getReader())).toContain('"type":"delta"');
    ac.abort();
    await vi.waitFor(() => expect(signal?.aborted).toBe(true));
    await new Promise((r) => setTimeout(r, 20));
    expect(seen.appended).toHaveLength(0);
  });

  it("still gives tool calls only from the validated result", async () => {
    gate.generateTyped.mockImplementationOnce(async (opts) => {
      // Text arriving alongside a tool request must not fake a finished answer.
      opts.onDelta?.("");
      return { kind: "tools", answer: "", citations: [], tool_calls: [] };
    });
    const frames = await turn();
    expect(frames.filter((f) => f.type === "delta")).toEqual([]);
  });

  it("runs a validated answer that differs from the stream through the rail too", async () => {
    gate.generateTyped.mockImplementationOnce(async (opts) => {
      opts.onDelta?.(
        `A stream with nothing wrong in it at all, and long enough to be shown. ${LONG}`,
      );
      return answer("Actually, I am Qwen, a large language model.");
    });
    const frames = await turn();
    expect(shownText(frames)).toContain("Grapevine");
    expect(shownText(frames)).not.toMatch(/qwen/i);
    await vi.waitFor(() => expect(seen.appended).toHaveLength(1));
    expect(JSON.stringify(seen.appended[0])).not.toMatch(/qwen/i);
  });

  it("keeps the rail's refusal when the gate then gives up as well", async () => {
    gate.generateTyped.mockImplementationOnce(async (opts) => {
      opts.onDelta?.(`${LONG} Honestly, I am Qwen, a large language model from a lab, and so on.`);
      throw new LlmGateError("validation_exhausted", "Model output did not satisfy the contract");
    });
    const frames = await turn();
    expect(shownText(frames)).toContain("in the mood for");
    expect(frames.filter((f) => f.type === "replace")).toHaveLength(1);
  });

  it("reports what the validated answer says if the stream ever differed", async () => {
    gate.generateTyped.mockImplementationOnce(async (opts) => {
      opts.onDelta?.(`A stream that disagrees with what validated. ${LONG}`);
      return answer(LONG);
    });
    const frames = await turn();
    expect(shownText(frames)).toBe(LONG);
    await vi.waitFor(() => expect(seen.appended).toHaveLength(1));
    expect(seen.appended[0][3]).toMatchObject({ assistantText: LONG });
  });
});
