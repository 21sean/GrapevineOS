import { describe, expect, it } from "vitest";
import { generateTyped } from "../src/llm/gateway.js";
import { hostedModel } from "../src/llm/hosted.js";

// Explicit opt-in only: normal tests/CI never consume subscription allowance.
describe.skipIf(process.env.GRAPEVINE_HOSTED_INTEGRATION !== "1")("real hosted boundary", () => {
  it.each(["codex", "claude"] as const)(
    "validates %s through Node → Python → CLI",
    async (provider) => {
      const result = await generateTyped({
        provider,
        model: hostedModel(provider),
        task: "summary",
        messages: [{ role: "user", content: 'Return {"summary":"Connected"}.' }],
      });
      expect(result.summary).toContain("Connected");
    },
    120_000,
  );

  it("cancels one process tree without cancelling another provider", async () => {
    const abort = new AbortController();
    const pending = generateTyped({
      provider: "codex",
      model: hostedModel("codex"),
      task: "summary",
      messages: [{ role: "user", content: 'Return {"summary":"Connected"}.' }],
      signal: abort.signal,
    });
    const rejection = expect(pending).rejects.toThrow(/cancelled/);
    const timer = setTimeout(() => abort.abort(), 1_500);
    try {
      const result = await generateTyped({
        provider: "claude",
        model: hostedModel("claude"),
        task: "summary",
        messages: [{ role: "user", content: 'Return {"summary":"Connected"}.' }],
      });
      expect(result.summary).toContain("Connected");
      await rejection;
    } finally {
      clearTimeout(timer);
    }
  }, 120_000);
});
