import { createServer } from "node:http";
import { afterEach, expect, it } from "vitest";
import { generateTyped, stopGate } from "../src/llm/gateway.js";

afterEach(() => stopGate());

/** A fake runtime that streams NDJSON a few characters at a time, per attempt. */
async function streamingRuntime(attempts: string[]) {
  let attempt = 0;
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const body = attempts[Math.min(attempt++, attempts.length - 1)];
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      for (let i = 0; i < body.length; i += 6) {
        res.write(
          JSON.stringify({ message: { content: body.slice(i, i + 6) }, done: false }) + "\n",
        );
      }
      res.end(
        JSON.stringify({
          message: { content: "" },
          done: true,
          done_reason: "stop",
          prompt_eval_count: 12,
          eval_count: 9,
        }) + "\n",
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test listener");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

const agentRequest = (baseUrl: string) => ({
  task: "agent" as const,
  messages: [{ role: "user" as const, content: "What is on?" }],
  baseUrl,
  context: { evidence: [{ id: "jazz", text: "Jazz at six" }], require_citations: true },
});

it.skipIf(process.env.GRAPEVINE_LLM_INTEGRATION !== "1")(
  "delivers answer text through the real worker before the validated result",
  async () => {
    const answer = 'Jazz at "six", then tacos.';
    const runtime = await streamingRuntime([
      JSON.stringify({ kind: "answer", answer, citations: ["jazz"], tool_calls: [] }),
    ]);
    try {
      const order: string[] = [];
      const text: string[] = [];
      const stats: { first_token_ms?: number | null; output_tokens?: number | null }[] = [];
      const output = await generateTyped({
        ...agentRequest(runtime.baseUrl),
        onDelta: (t) => {
          order.push("delta");
          text.push(t);
        },
        onStats: (s) => {
          order.push("stats");
          stats.push(s);
        },
      });
      expect(text.join("")).toBe(answer);
      expect(output.answer).toBe(answer);
      expect(order.at(-1)).toBe("stats");
      expect(order[0]).toBe("delta");
      expect(stats[0].first_token_ms).toBeGreaterThan(0);
      expect(stats[0].output_tokens).toBe(9);
    } finally {
      await runtime.close();
    }
  },
  20_000,
);

it.skipIf(process.env.GRAPEVINE_LLM_INTEGRATION !== "1")(
  "tells the caller to take back an attempt that fails validation",
  async () => {
    const runtime = await streamingRuntime([
      // Cites evidence that was never supplied, so the gate must reject it.
      JSON.stringify({ kind: "answer", answer: "Made up.", citations: ["nope"], tool_calls: [] }),
      JSON.stringify({
        kind: "answer",
        answer: "Jazz at six.",
        citations: ["jazz"],
        tool_calls: [],
      }),
    ]);
    try {
      const events: string[] = [];
      const output = await generateTyped({
        ...agentRequest(runtime.baseUrl),
        onDelta: (t) => events.push(t),
        onReset: () => events.push("<reset>"),
      });
      const reset = events.indexOf("<reset>");
      expect(events.slice(0, reset).join("")).toBe("Made up.");
      expect(events.slice(reset + 1).join("")).toBe("Jazz at six.");
      expect(output.answer).toBe("Jazz at six.");
    } finally {
      await runtime.close();
    }
  },
  20_000,
);

it.skipIf(process.env.GRAPEVINE_LLM_INTEGRATION !== "1")(
  "never streams anything but the agent's answer",
  async () => {
    const runtime = await streamingRuntime([
      JSON.stringify({ rating: 4, rationale: "Local jazz", promoted: false }),
    ]);
    try {
      const text: string[] = [];
      await generateTyped({
        task: "rating",
        messages: [{ role: "user", content: "Rate jazz" }],
        baseUrl: runtime.baseUrl,
        onDelta: (t) => text.push(t),
      });
      expect(text).toEqual([]);
    } finally {
      await runtime.close();
    }
  },
  20_000,
);

it.skipIf(process.env.GRAPEVINE_LLM_INTEGRATION !== "1")(
  "rejects with no output when every attempt fails, after taking back what it showed",
  async () => {
    const runtime = await streamingRuntime([
      JSON.stringify({ kind: "answer", answer: "Made up.", citations: ["nope"], tool_calls: [] }),
    ]);
    try {
      const events: string[] = [];
      await expect(
        generateTyped({
          ...agentRequest(runtime.baseUrl),
          onDelta: (t) => events.push(t),
          onReset: () => events.push("<reset>"),
        }),
      ).rejects.toMatchObject({ code: "validation_exhausted" });
      expect(events.at(-1)).toBe("<reset>");
    } finally {
      await runtime.close();
    }
  },
  20_000,
);
it.skipIf(process.env.GRAPEVINE_LLM_INTEGRATION !== "1")(
  "runs the real Python worker and validates the wire boundary",
  async () => {
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        expect(JSON.parse(body).format.additionalProperties).toBe(false);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            message: {
              content: JSON.stringify({ rating: 4, rationale: "Local jazz", promoted: false }),
            },
          }),
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("No test listener");
      const output = await generateTyped({
        task: "rating",
        messages: [{ role: "user", content: "Rate jazz" }],
        baseUrl: `http://127.0.0.1:${address.port}`,
      });
      expect(output).toEqual({ rating: 4, rationale: "Local jazz", promoted: false });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    }
  },
  20_000,
);

it.skipIf(process.env.GRAPEVINE_LLM_INTEGRATION !== "1")(
  "runs the real Python worker against the vLLM endpoint when selected",
  async () => {
    const seen: { url?: string; body?: any } = {};
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        seen.url = req.url;
        seen.body = JSON.parse(body);
        const content = JSON.stringify({ rating: 4, rationale: "Local jazz", promoted: false });
        res.writeHead(200, { "content-type": "text/event-stream" });
        for (const piece of [content.slice(0, 5), content.slice(5)])
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
        res.write(
          `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`,
        );
        res.end("data: [DONE]\n\n");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    process.env.GRAPEVINE_LLM_RUNTIME = "vllm";
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("No test listener");
      const output = await generateTyped({
        task: "rating",
        messages: [{ role: "user", content: "Rate jazz" }],
        baseUrl: `http://127.0.0.1:${address.port}`,
        model: "qwen3.8-27b-int4",
      });
      expect(output).toEqual({ rating: 4, rationale: "Local jazz", promoted: false });
      expect(seen.url).toBe("/v1/chat/completions");
      expect(seen.body.response_format.json_schema.schema.additionalProperties).toBe(false);
      expect(seen.body.chat_template_kwargs).toEqual({ enable_thinking: false });
    } finally {
      delete process.env.GRAPEVINE_LLM_RUNTIME;
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    }
  },
  20_000,
);
