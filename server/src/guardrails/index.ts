/**
 * HTTP surface for guardrail observability — the rails half of
 * Admin → Monitoring.
 *
 *   GET   /api/guardrails                 the dashboard, in one round trip
 *   GET   /api/guardrails/scans           the review queue
 *   POST  /api/guardrails/scans/:id/label record a judgement
 *   PATCH /api/guardrails/config          retune mode / threshold
 *
 * The point of the whole surface is the thing the rails could not answer
 * before: what the score distribution looks like on traffic that was NOT
 * blocked. Everything here follows from that — the histogram shows it, the
 * sweep prices a change to it, the review queue is how it gets labelled, and
 * the config route is what closes the loop by letting the number actually move.
 */
import { Router } from "express";
import {
  classifierReady,
  GUARD_MODEL,
  GUARD_MODEL_LABEL,
  guardConfig,
  invalidateGuardConfig,
} from "../agent/guardrails.js";
import { flush, telemetryHealth } from "../agent/telemetry.js";
import { safeDetail } from "../evals/harness.js";
import { adminAllowed } from "../auth.js";
import { store } from "../store.js";
import {
  isGuardrailLabel,
  isGuardrailMode,
  type GuardrailDashboard,
  type GuardrailLabel,
  type GuardrailRail,
} from "../types.js";
import { railStats, sweep, type RawStats } from "./stats.js";

export const guardrails = Router();

/** Bounds that keep a hand-typed query string from asking for a table scan. */
const clampWindow = (v: unknown) => Math.min(365, Math.max(1, Number(v) || 7));
const clampBuckets = (v: unknown) => Math.min(50, Math.max(10, Number(v) || 20));

function railParam(v: unknown): GuardrailRail | undefined {
  return v === "input" || v === "content" || v === "output" ? v : undefined;
}

guardrails.get("/api/guardrails", async (req, res) => {
  if (!(await adminAllowed(req))) return res.status(403).json({ error: "admin only" });
  const windowDays = clampWindow(req.query.window);
  const buckets = clampBuckets(req.query.buckets);
  try {
    // Drain first: a panel opened seconds after a chat turn should show that
    // turn, not the state as of the last two-second tick.
    await flush();

    const [raw, labelled, cfg] = await Promise.all([
      store.guardrailStats(windowDays, buckets) as Promise<RawStats>,
      store.guardrailLabelled(),
      guardConfig(),
    ]);

    const rails = railStats(raw);
    // The sweep is over the input rail: it is the one facing users, the one
    // false positives are felt on, and the only one whose threshold is being
    // asked about. Pooling it with content scans would average a chat message
    // against a scraped page.
    const input = rails.find((r) => r.rail === "input");
    const inputLabelled = labelled.filter((r) => r.rail === "input");

    const labelCounts = labelled.reduce(
      (acc, r) => {
        acc[r.label]++;
        return acc;
      },
      { correct: 0, false_positive: 0, false_negative: 0 } as Record<GuardrailLabel, number>,
    );

    const dashboard: GuardrailDashboard = {
      mode: cfg.mode,
      threshold: cfg.threshold,
      model: GUARD_MODEL,
      modelLabel: GUARD_MODEL_LABEL,
      classifierReady: classifierReady(),
      windowDays: raw.windowDays ?? windowDays,
      total: raw.total ?? 0,
      oldest: raw.oldest ?? null,
      rails,
      daily: Array.isArray(raw.daily) ? raw.daily : [],
      sweep: sweep(input?.recent.buckets ?? [], inputLabelled),
      labelCounts,
      health: telemetryHealth(),
    };
    res.json(dashboard);
  } catch (err) {
    res.status(502).json({ error: safeDetail(String(err)) });
  }
});

/**
 * The review queue. Defaults to the highest-scoring unlabelled decisions,
 * because that is where both mistakes live: the top of the allowed pile is
 * where a false negative hides, and the bottom of the blocked pile is where a
 * false positive does.
 */
guardrails.get("/api/guardrails/scans", async (req, res) => {
  if (!(await adminAllowed(req))) return res.status(403).json({ error: "admin only" });
  try {
    const scans = await store.guardrailScans({
      rail: railParam(req.query.rail),
      blocked:
        req.query.blocked === "true" ? true : req.query.blocked === "false" ? false : undefined,
      unlabelled: req.query.unlabelled === "true",
      minScore: req.query.min_score !== undefined ? Number(req.query.min_score) : undefined,
      order: req.query.order === "recent" ? "recent" : "score",
      limit: Number(req.query.limit) || 100,
    });
    res.json({ scans });
  } catch (err) {
    res.status(502).json({ error: safeDetail(String(err)) });
  }
});

/** Record (or clear, with label:null) an operator's judgement of one decision. */
guardrails.post("/api/guardrails/scans/:id/label", async (req, res) => {
  if (!(await adminAllowed(req))) return res.status(403).json({ error: "admin only" });
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "bad id" });
  const raw = req.body?.label;
  if (raw !== null && !isGuardrailLabel(raw)) {
    return res
      .status(400)
      .json({ error: "label must be correct, false_positive, false_negative, or null" });
  }
  try {
    const ok = await store.labelGuardrailScan(id, raw);
    if (!ok) return res.status(404).json({ error: "unknown scan" });
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: safeDetail(String(err)) });
  }
});

/**
 * Retune. Writing to settings rather than to env is the whole point: a
 * threshold you have to redeploy to change is a threshold that never changes,
 * however good the chart above it is.
 *
 * GUARDRAILS=off still wins on the process — a kill switch that a web request
 * can undo is not a kill switch — and the panel says so when it applies.
 */
guardrails.patch("/api/guardrails/config", async (req, res) => {
  if (!(await adminAllowed(req))) return res.status(403).json({ error: "admin only" });
  const patch: { guardMode?: typeof req.body.mode; guardThreshold?: number } = {};

  if (req.body?.mode !== undefined) {
    if (!isGuardrailMode(req.body.mode)) {
      return res.status(400).json({ error: "mode must be on, observe, or off" });
    }
    patch.guardMode = req.body.mode;
  }
  if (req.body?.threshold !== undefined) {
    const t = Number(req.body.threshold);
    // 0 would block every message ever sent; over 1 is unreachable and turns
    // the rail off while looking like it is on.
    if (!Number.isFinite(t) || t <= 0 || t > 1) {
      return res.status(400).json({ error: "threshold must be between 0 (exclusive) and 1" });
    }
    patch.guardThreshold = t;
  }
  if (!Object.keys(patch).length) {
    return res.status(400).json({ error: "nothing to update (mode, threshold)" });
  }

  try {
    const saved = await store.saveSettings(patch);
    invalidateGuardConfig();
    const effective = await guardConfig();
    res.json({
      mode: effective.mode,
      threshold: effective.threshold,
      ...(effective.mode !== saved.guardMode && {
        note: "GUARDRAILS=off is set on the server process and overrides the saved mode.",
      }),
    });
  } catch (err) {
    res.status(502).json({ error: safeDetail(String(err)) });
  }
});
