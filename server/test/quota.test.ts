/**
 * The daily token budget: what a turn is charged, where the count lives, and
 * what happens to chat when the database holding the count is not there.
 */
import type { Request, Response } from "express";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  rows: new Map<string, number>(),
  failing: false,
  reads: 0,
}));
vi.mock("../src/store.js", () => ({
  store: {
    llmUsage: async (userId: string, day: string) => {
      db.reads++;
      if (db.failing) throw new Error('relation "public.llm_usage" does not exist');
      return db.rows.get(`${userId}|${day}`) ?? 0;
    },
    recordLlmUsage: async (userId: string, day: string, tokens: number) => {
      if (db.failing) throw new Error('relation "public.llm_usage" does not exist');
      const total = (db.rows.get(`${userId}|${day}`) ?? 0) + tokens;
      db.rows.set(`${userId}|${day}`, total);
      return total;
    },
  },
}));

const { chargeable, dailyLimit, record, resetQuota, spent, tokenQuota } =
  await import("../src/quota.js");

const account = { key: "user-1", userId: "user-1" };
const address = { key: "ip:203.0.113.7" };
const noon = new Date("2026-11-18T12:00:00Z");
const saved = { ...process.env };

function reply() {
  const headers: Record<string, string> = {};
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    headers,
    setHeader: (k: string, v: string) => void (headers[k] = v),
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(body: unknown) {
      res.body = body;
      return res;
    },
  };
  return res;
}
const ask = async (subject: typeof account | typeof address) => {
  const res = reply();
  let passed = false;
  await tokenQuota({ subject: () => subject })(
    {} as Request,
    res as unknown as Response,
    () => (passed = true),
  );
  return { passed, res };
};

beforeEach(() => {
  db.rows.clear();
  db.failing = false;
  db.reads = 0;
  resetQuota();
  delete process.env.CHAT_DAILY_TOKENS;
  delete process.env.CHAT_DAILY_TOKENS_ANON;
});
afterEach(() => {
  process.env = { ...saved };
  vi.useRealTimers();
});

it("charges the prompt tokens the GPU evaluated plus what it generated", () => {
  expect(chargeable({ inputTokens: 4_000, outputTokens: 250 })).toBe(4_250);
  // A tool loop re-sends the prompt; the runtime reads most of it back from its prefix cache.
  expect(chargeable({ inputTokens: 4_300, outputTokens: 120, cacheReadInputTokens: 4_000 })).toBe(
    420,
  );
  // A runtime that reports more cached than sent does not earn a refund.
  expect(chargeable({ inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 50 })).toBe(5);
});

it("gives an account a larger day than an address, and lets either be changed or switched off", () => {
  expect(dailyLimit(account)).toBe(500_000);
  expect(dailyLimit(address)).toBe(100_000);
  process.env.CHAT_DAILY_TOKENS = "2000";
  process.env.CHAT_DAILY_TOKENS_ANON = "0";
  expect(dailyLimit(account)).toBe(2_000);
  expect(dailyLimit(address)).toBe(0);
  // Not a number: the default, not an accidental zero.
  process.env.CHAT_DAILY_TOKENS = "lots";
  expect(dailyLimit(account)).toBe(500_000);
});

it("counts an account in the database, per UTC day", async () => {
  await record(account, 1_200, noon);
  await record(account, 300, noon);
  expect(db.rows.get("user-1|2026-11-18")).toBe(1_500);
  expect(await spent(account, noon)).toBe(1_500);
  // Another person, and the same person tomorrow, start from nothing.
  expect(await spent({ key: "user-2", userId: "user-2" }, noon)).toBe(0);
  expect(await spent(account, new Date("2026-11-19T00:00:01Z"))).toBe(0);
});

it("counts an address in this process and never asks the database about it", async () => {
  await record(address, 900, noon);
  expect(await spent(address, noon)).toBe(900);
  expect(db.rows.size).toBe(0);
  expect(db.reads).toBe(0);
  expect(await spent(address, new Date("2026-11-19T00:00:01Z"))).toBe(0);
});

it("keeps counting in this process when the database is down, and adds the two when it is back", async () => {
  await record(account, 1_000, noon);
  db.failing = true;
  await record(account, 400, noon);
  // The database cannot be read: only what was counted here is known.
  expect(await spent(account, noon)).toBe(400);
  db.failing = false;
  expect(await spent(account, noon)).toBe(1_400);
});

it("ignores a turn that reported no tokens", async () => {
  await record(account, 0, noon);
  await record(address, Number.NaN, noon);
  expect(db.rows.size).toBe(0);
  expect(await spent(address, noon)).toBe(0);
});

it("refuses a turn once the day is spent and says when to come back", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-18T23:30:00Z"));
  process.env.CHAT_DAILY_TOKENS = "1000";
  await record(account, 999);
  expect((await ask(account)).passed).toBe(true);
  // The turn that crosses the line was allowed to finish; the next one is not.
  await record(account, 600);
  const { passed, res } = await ask(account);
  expect(passed).toBe(false);
  expect(res.statusCode).toBe(429);
  expect(res.headers["Retry-After"]).toBe("1800");
  expect(res.body).toEqual({
    error: "You've used today's chat allowance. It resets at midnight UTC.",
  });
  // Someone else is untouched, and so is this account after midnight.
  expect((await ask({ key: "user-2", userId: "user-2" })).passed).toBe(true);
  vi.setSystemTime(new Date("2026-11-19T00:00:05Z"));
  expect((await ask(account)).passed).toBe(true);
});

it("holds an address to its own smaller day and points it at signing in", async () => {
  process.env.CHAT_DAILY_TOKENS_ANON = "500";
  await record(address, 500);
  const { passed, res } = await ask(address);
  expect(passed).toBe(false);
  expect((res.body as { error: string }).error).toMatch(/Sign in for a larger one/);
  expect((await ask({ key: "ip:198.51.100.2" })).passed).toBe(true);
});

it("lets everyone through when the limit is switched off or the database is gone", async () => {
  process.env.CHAT_DAILY_TOKENS = "0";
  await record(account, 10_000_000);
  expect((await ask(account)).passed).toBe(true);

  process.env.CHAT_DAILY_TOKENS = "1000";
  db.failing = true;
  // 10M tokens are in the database, but it cannot be read: chat is not held hostage to it.
  expect((await ask(account)).passed).toBe(true);
});
