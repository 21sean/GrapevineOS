import { describe, expect, it, vi } from "vitest";

/** The stored provider columns are free text, so what comes back has to be coerced. */
const row = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock("../src/db.js", () => {
  const query = {
    select: () => query,
    eq: () => query,
    maybeSingle: () => query,
    throwOnError: async () => ({ data: row.value }),
  };
  return { db: { from: () => query } };
});

import { store } from "../src/store.js";

const saved = (chat: string, extract: string) => {
  row.value = {
    city: "Testville",
    center_lng: 0,
    center_lat: 0,
    tz: "UTC",
    model: "",
    ollama_url: "",
    chat_provider: chat,
    extract_provider: extract,
    guard_mode: "on",
    guard_threshold: 0.8,
  };
  return store.settingsUncached();
};

describe("the saved providers", () => {
  it("keep a CLI from before v0.7.0, so the app can name it and offer the way back", async () => {
    expect(await saved("claude", "copilot")).toMatchObject({
      chatProvider: "claude",
      extractProvider: "copilot",
    });
  });

  it("fall back to the local runtime on a value that was never a provider", async () => {
    expect(await saved("mystery", "")).toMatchObject({
      chatProvider: "ollama",
      extractProvider: "ollama",
    });
  });
});
