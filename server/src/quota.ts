/**
 * A daily token budget for chat, per person.
 *
 * The request-rate limit in rate-limit.ts bounds how often someone can ask. It
 * does not bound how much of the GPU they get: twenty long turns a minute, all
 * day, is inside it. This is the other limit. Each account gets a number of
 * tokens per UTC day, and an address with nobody signed in gets a smaller one.
 *
 * What is charged is the work the card did, as the runtime reported it: the
 * prompt tokens it evaluated (not the ones it read back from its prefix cache)
 * plus the tokens it generated, summed over every model call in the turn. A
 * turn is charged after it runs, so a budget can be overshot by one turn;
 * cutting an answer off halfway to be exact would be the worse trade.
 *
 * Accounts are counted in Postgres (llm_usage), so a restart does not hand
 * everyone a fresh day. Addresses are counted in this process. When the
 * database cannot be read or written, an account's count falls back to this
 * process as well and chat carries on: a quota that takes chat down with the
 * database is a worse failure than a quota that forgets.
 */
import type { NextFunction, Request, Response } from "express";
import { logger } from "./log.js";
import { store } from "./store.js";
import type { ChatUsage } from "./types.js";

const log = logger("quota");

/** Who a budget belongs to: an account, or an address when nobody is signed in. */
export interface Subject {
  key: string;
  userId?: string;
}

const DEFAULT_DAILY_TOKENS = { account: 500_000, address: 100_000 };

function setting(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

/** Tokens per UTC day for this subject. 0 means no limit. */
export function dailyLimit(subject: Subject): number {
  return subject.userId
    ? setting("CHAT_DAILY_TOKENS", DEFAULT_DAILY_TOKENS.account)
    : setting("CHAT_DAILY_TOKENS_ANON", DEFAULT_DAILY_TOKENS.address);
}

/** What one model call cost the GPU: prompt tokens it had to evaluate, plus its output. */
export function chargeable(
  usage: Pick<ChatUsage, "inputTokens" | "outputTokens" | "cacheReadInputTokens">,
): number {
  const evaluated = Math.max(0, usage.inputTokens - (usage.cacheReadInputTokens ?? 0));
  return evaluated + Math.max(0, usage.outputTokens);
}

const utcDay = (now: Date) => now.toISOString().slice(0, 10);

function secondsToUtcMidnight(now: Date): number {
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(1, Math.ceil((midnight - now.getTime()) / 1000));
}

// Tokens counted here rather than in Postgres: everything for an address, and
// for an account only what the database could not be told. Entries are made
// when a turn finishes, so the map grows no faster than the GPU answers, and
// it is dropped whole when the day turns.
let local = { day: "", tokens: new Map<string, number>() };
function localTokens(day: string): Map<string, number> {
  if (local.day !== day) local = { day, tokens: new Map() };
  return local.tokens;
}

// Said once per outage, not once per turn.
let databaseDown = false;
function databaseFailed(err: unknown): void {
  if (databaseDown) return;
  databaseDown = true;
  log.warn(
    { err: String((err as Error)?.message ?? err).slice(0, 200) },
    "llm_usage is not answering; counting chat tokens in this process until it does",
  );
}

/** Tokens this subject has used today. */
export async function spent(subject: Subject, now = new Date()): Promise<number> {
  const day = utcDay(now);
  const here = localTokens(day).get(subject.key) ?? 0;
  if (!subject.userId) return here;
  try {
    const stored = await store.llmUsage(subject.userId, day);
    databaseDown = false;
    return stored + here;
  } catch (err) {
    databaseFailed(err);
    return here;
  }
}

/** Charge a finished turn. Never throws: accounting must not fail a turn that already answered. */
export async function record(subject: Subject, tokens: number, now = new Date()): Promise<void> {
  if (!(tokens > 0)) return;
  const day = utcDay(now);
  if (subject.userId) {
    try {
      await store.recordLlmUsage(subject.userId, day, tokens);
      databaseDown = false;
      return;
    } catch (err) {
      databaseFailed(err);
    }
  }
  const counts = localTokens(day);
  counts.set(subject.key, (counts.get(subject.key) ?? 0) + tokens);
}

/** Refuse a turn from someone who has used today's budget, and say when it comes back. */
export function tokenQuota(opts: { subject: (req: Request) => Promise<Subject> | Subject }) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const subject = await opts.subject(req);
    const limit = dailyLimit(subject);
    if (limit > 0 && (await spent(subject)) >= limit) {
      res.setHeader("Retry-After", String(secondsToUtcMidnight(new Date())));
      res.status(429).json({
        error: subject.userId
          ? "You've used today's chat allowance. It resets at midnight UTC."
          : "This address has used today's chat allowance. Sign in for a larger one, or come back after midnight UTC.",
      });
      return;
    }
    next();
  };
}

/** Forget every in-process count. For tests. */
export function resetQuota(): void {
  local = { day: "", tokens: new Map() };
  databaseDown = false;
}
