import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { AgentCtx } from "../src/agent/context.js";
import {
  CONTRACTS,
  TOOL_LIST,
  cliToolsNote,
  coerceQuery,
  parseArgs,
  toolDetail,
  toolLabel,
  toolsFor,
} from "../src/agent/contracts.js";
import { makeTools } from "../src/agent/tools.js";

const ctx: AgentCtx = {
  upcoming: [],
  byId: new Map(),
  settings: {
    city: "Testville",
    center: [0, 0],
    tz: "UTC",
    model: "test",
    ollamaUrl: "",
    chatProvider: "ollama",
    extractProvider: "ollama",
    guardMode: "on",
    guardThreshold: 0.8,
  },
  now: new Date("2026-09-03T00:00:00Z"),
};

describe("the tool contracts", () => {
  it("name every tool once, under its own key", () => {
    for (const [key, c] of Object.entries(CONTRACTS)) expect(c.name).toBe(key);
    expect(new Set(TOOL_LIST.map((c) => c.name)).size).toBe(TOOL_LIST.length);
  });

  it("are exactly what the graph binds, in order", () => {
    const bound = makeTools(ctx, {}).map((t) => t.name);
    expect(bound).toEqual(toolsFor("graph").map((c) => c.name));
  });

  it("put every tool on at least one surface", () => {
    for (const c of TOOL_LIST) expect(c.surfaces.length, c.name).toBeGreaterThan(0);
  });

  it("keep interests as propose everywhere, with the write behind confirmed:true", () => {
    expect(CONTRACTS.update_interests.effect).toBe("propose");
    expect(parseArgs("apply_interests", { add_loves: ["jazz"] }).ok).toBe(false);
    expect(parseArgs("apply_interests", { add_loves: ["jazz"], confirmed: true }).ok).toBe(true);
    expect(parseArgs("apply_interests", { add_loves: ["jazz"], confirmed: false }).ok).toBe(false);
  });

  it("make discovery a dry run unless told otherwise", () => {
    const p = parseArgs("discover_events", { query: "jazz tonight" });
    expect(p.ok && p.args.dry_run).toBeUndefined();
    const commit = parseArgs("discover_events", { query: "jazz tonight", dry_run: false });
    expect(commit.ok && commit.args.dry_run).toBe(false);
    expect(parseArgs("discover_events", { query: "no" }).ok).toBe(false);
  });

  it("accept a coordinate as a tuple or a string on the same schema", () => {
    expect(parseArgs("get_eta", { to: [-117.16, 32.71] }).ok).toBe(true);
    expect(parseArgs("get_eta", { to: "-117.16,32.71" }).ok).toBe(true);
    expect(parseArgs("get_eta", { to: "somewhere" }).ok).toBe(false);
  });
});

describe("parsing", () => {
  it("coerces a query string into what the schema says", () => {
    const q = coerceQuery(CONTRACTS.search_events.schema, {
      free_only: "true",
      limit: "5",
      categories: "music, food",
      query: "jazz",
      junk: "dropped",
      date_from: "",
    });
    expect(q).toEqual({ free_only: true, limit: 5, categories: ["music", "food"], query: "jazz" });
  });

  it("names every bad field at once", () => {
    const p = parseArgs("schedule_search", { query: "ab", cadence_hours: 999 });
    expect(p.ok).toBe(false);
    if (!p.ok) {
      expect(p.error).toContain("query");
      expect(p.error).toContain("cadence_hours");
    }
  });
});

describe("derived prose", () => {
  it("labels and details come from the contract, unknown names fall through", () => {
    expect(toolLabel("search_events", { query: "jazz" })).toBe("Searching: jazz");
    expect(toolLabel("search_events")).toBe("Searching events");
    expect(toolLabel("not_a_tool")).toBe("not_a_tool");
    expect(toolDetail("search_events", JSON.stringify({ count: 3 }))).toBe("3 results");
    expect(toolDetail("search_events", JSON.stringify({ count: 1 }))).toBe("1 result");
    expect(toolDetail("get_eta", JSON.stringify({ error: "no route" }))).toBe("failed");
    expect(toolDetail("get_eta", "not json")).toBeUndefined();
  });

  it("tell a CLI about the MCP tools and the app-only ones", () => {
    const note = cliToolsNote();
    for (const c of toolsFor("mcp")) expect(note).toContain(c.name);
    expect(note).toContain("show_on_map");
    expect(note).toContain("apply_interests");
  });

  it("match the generated skill file on disk", () => {
    const cwd = fileURLToPath(new URL("..", import.meta.url));
    execFileSync("npx", ["tsx", "scripts/contracts-gen.ts", "--check"], {
      cwd,
      shell: process.platform === "win32",
      stdio: "pipe",
    });
  });
});
