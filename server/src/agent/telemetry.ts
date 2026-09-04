/**
 * Guardrail telemetry: the write side.
 *
 * The rails already knew every score. What was missing was somewhere for the
 * ones that didn't block to go, and this is it — one row per decision, so the
 * distribution on ordinary traffic becomes something you can look at instead
 * of something you assume.
 *
 * Three properties matter more than throughput here:
 *
 *  - It is never in the request path. Recording is fire-and-forget into a
 *    bounded queue that a timer drains; a chat turn is never slowed down, and
 *    never fails, because telemetry is slow or the database is unreachable.
 *  - It cannot take chat down. Every failure mode — no credentials, a rejected
 *    insert, a queue that fills faster than it drains — degrades to dropped
 *    rows and a counter the panel shows, never to an exception reaching the
 *    caller. A rail that fails open on the classifier must not fail closed on
 *    its own bookkeeping.
 *  - It drops the oldest, not the newest. When the queue overflows the
 *    interesting rows are the ones that just happened.
 *
 * Text is stored (see the migration for why, and for the bound), truncated to
 * MAX_TEXT_CHARS: a fetched page can be a hundred kilobytes and the first few
 * thousand characters are what a person needs to judge the call. The hash is
 * over the whole normalized text, so grouping repeats still works on rows
 * whose text was cut or later swept.
 */
import { createHash } from "node:crypto";
import { db } from "../db.js";
import type { TablesInsert } from "../db-types.js";
import { recordRailScore } from "../langfuse.js";
import type { GuardrailRail, GuardrailSurface } from "../types.js";
import { logger } from "../log.js";

const log = logger("telemetry");

/** Enough of the text to judge a decision by; a page is far longer than this. */
const MAX_TEXT_CHARS = 8_000;

/** Rows held in memory before the writer drains them. */
const QUEUE_LIMIT = 500;

/** Drain cadence. Long enough to batch a burst, short enough to feel live. */
const FLUSH_MS = 2_000;

/** Rows per insert. Supabase is happy with far more; this bounds one failure. */
const BATCH = 100;

export interface ScanRecord {
  rail: GuardrailRail;
  surface: GuardrailSurface;
  /** MALICIOUS probability, or undefined for the score-less output rail. */
  score?: number;
  threshold?: number;
  blocked: boolean;
  /** Observe mode: over threshold, deliberately allowed through. */
  wouldBlock?: boolean;
  ms: number;
  text: string;
  guardModel?: string;
  /** Output rail: the pattern that tripped. */
  pattern?: string;
  provider?: string;
  threadId?: string;
  userId?: string;
}

function storeText(): boolean {
  return process.env.GUARDRAIL_STORE_TEXT !== "off";
}

/**
 * sha256 over whitespace-normalized text, salted when GUARDRAIL_HASH_SALT is
 * set. Its job is grouping — the same probe retried, the same scraped page —
 * not secrecy, which is why an unset salt is a fine default.
 */
export function textHash(text: string): string {
  return createHash("sha256")
    .update(process.env.GUARDRAIL_HASH_SALT ?? "")
    .update(text.replace(/\s+/g, " ").trim().toLowerCase())
    .digest("hex")
    .slice(0, 32);
}

type Row = TablesInsert<"guardrail_scans">;

const queue: Row[] = [];
let timer: ReturnType<typeof setInterval> | null = null;
let draining = false;
let dropped = 0;
let written = 0;
let lastError: string | null = null;

function toRow(r: ScanRecord): Row {
  const text = r.text.trim();
  return {
    rail: r.rail,
    surface: r.surface,
    // The output rail has no score. Storing 0 would drag every percentile
    // toward zero with values that were never measurements.
    score: r.score ?? null,
    threshold: r.threshold ?? null,
    blocked: r.blocked,
    would_block: r.wouldBlock ?? false,
    ms: Math.max(0, Math.round(r.ms)),
    chars: text.length,
    text_hash: textHash(text),
    text: storeText() ? text.slice(0, MAX_TEXT_CHARS) : null,
    guard_model: r.guardModel ?? null,
    pattern: r.pattern ?? null,
    provider: r.provider ?? null,
    thread_id: r.threadId ?? null,
    user_id: r.userId ?? null,
  };
}

/**
 * Queue one decision. Returns immediately; the caller never awaits, never
 * catches, and never learns whether the write succeeded — by design.
 */
export function recordScan(r: ScanRecord): void {
  if (!r.text.trim()) return;
  // Mirror the decision into Langfuse as a session score (no-op without
  // keys). Same posture as the queue below: never in the request path.
  recordRailScore(r);
  if (queue.length >= QUEUE_LIMIT) {
    // Oldest first: during a burst the rows worth keeping are the new ones.
    queue.shift();
    dropped++;
  }
  queue.push(toRow(r));
  if (!timer) {
    timer = setInterval(() => void flush(), FLUSH_MS);
    // Telemetry must never be the reason the process stays alive.
    timer.unref?.();
  }
}

/**
 * Drain the queue. Safe to call concurrently (a second call returns while the
 * first is in flight) and safe to call with no credentials configured — the
 * rows are counted as dropped and the reason is surfaced once.
 */
export async function flush(): Promise<void> {
  if (draining || !queue.length) return;
  draining = true;
  try {
    while (queue.length) {
      const batch = queue.splice(0, BATCH);
      try {
        await db.from("guardrail_scans").insert(batch).throwOnError();
        written += batch.length;
        lastError = null;
      } catch (err) {
        dropped += batch.length;
        const message = String(err).slice(0, 200);
        if (lastError !== message) {
          lastError = message;
          log.warn(`telemetry write failed, rows dropped: ${message}`);
        }
        // A failing database will fail for the rest of the queue too; stop
        // here and let the next tick retry rather than burning the backlog.
        break;
      }
    }
  } finally {
    draining = false;
  }
}

/** Queue health, for the panel. A rising `dropped` means numbers are partial. */
export function telemetryHealth(): {
  queued: number;
  written: number;
  dropped: number;
  storingText: boolean;
  lastError: string | null;
} {
  return { queued: queue.length, written, dropped, storingText: storeText(), lastError };
}
