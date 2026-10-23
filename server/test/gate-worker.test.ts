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
