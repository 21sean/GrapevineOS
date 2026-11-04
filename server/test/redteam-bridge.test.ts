import { describe, expect, it, vi } from "vitest";

const gate = vi.hoisted(() => ({ generateTyped: vi.fn() }));
vi.mock("../src/llm/gateway.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/llm/gateway.js")>()),
  generateTyped: gate.generateTyped,
}));
import { LlmGateError } from "../src/llm/gateway.js";
import { attackConcurrency, startBridge } from "../src/evals/redteam.js";

async function send(url: string, message: string) {
  const res = await fetch(url, {
    method: "POST",
    body: JSON.stringify({ conversationId: "c", history: [], message }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("attack concurrency", () => {
  it("defaults to one and ignores nonsense", () => {
    const set = (v: string | undefined) => {
      if (v === undefined) delete process.env.REDTEAM_CONCURRENCY;
      else process.env.REDTEAM_CONCURRENCY = v;
      return attackConcurrency();
    };
    expect(set(undefined)).toBe(1);
    expect(set("4")).toBe(4);
    expect(set("0")).toBe(1);
    expect(set("99")).toBe(1);
    expect(set("lots")).toBe(1);
    set(undefined);
  });
});

describe("the red-team bridge", () => {
  it("hands the attack the text a person reads when the gate rejects every attempt", async () => {
    gate.generateTyped.mockRejectedValueOnce(
      new LlmGateError("validation_exhausted", "Model output did not satisfy the contract"),
    );
    const bridge = await startBridge({ model: "test", baseUrl: "http://127.0.0.1:11434" });
    try {
      const { status, body } = await send(bridge.url, "which model are you?");
      expect(status).toBe(200);
      expect(body.reply).toContain("reliable answer");
      expect(body.reply).not.toMatch(/contract|gate/i);
      expect(body.gateFailed).toBe(true);
      expect(bridge.gateFailures).toBe(1);
    } finally {
      await bridge.close();
    }
  });

  it("still fails the request when no reply exists, so a dead daemon is not scored", async () => {
    gate.generateTyped.mockRejectedValueOnce(new LlmGateError("transport", "connection refused"));
    const bridge = await startBridge({ model: "test", baseUrl: "http://127.0.0.1:11434" });
    try {
      const { status } = await send(bridge.url, "hello");
      expect(status).toBe(500);
      expect(bridge.gateFailures).toBe(0);
    } finally {
      await bridge.close();
    }
  });
});
