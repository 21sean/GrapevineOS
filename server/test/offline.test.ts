import { describe, expect, it } from "vitest";
import { localTraceEndpoint } from "../src/offline.js";
describe("offline tracing", () => {
  it("rejects missing and cloud endpoints", () => {
    for (const url of [
      undefined,
      "https://cloud.langfuse.com",
      "http://localhost.evil.test",
      "http://user:pass@localhost",
    ])
      expect(localTraceEndpoint(url)).toBe(false);
    expect(localTraceEndpoint("http://localhost:3000")).toBe(true);
  });
});
