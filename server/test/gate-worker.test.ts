import { createServer } from "node:http";
import { afterEach, expect, it } from "vitest";
import { generateTyped, stopGate } from "../src/llm/gateway.js";

afterEach(() => stopGate());
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
