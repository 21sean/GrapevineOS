/**
 * HTTP surface for the eval harness — the three routes behind Admin → Evals.
 *
 *   GET  /api/evals          the catalog: suites, personas, last run
 *   POST /api/evals/run      NDJSON, one frame per case as it finishes
 *   GET  /api/evals/history  recent runs, newest first
 *
 * The run streams rather than returning at the end. A suite that takes two
 * minutes behind a silent request is indistinguishable from a hung server, and
 * the operator watching it has no way to tell which case is slow.
 *
 * Access: when ADMIN_EMAILS is set these routes require a signed-in user on
 * that list; unset, they are open exactly like the rest of the admin surface,
 * which is how this app is run locally. That default is deliberate and stated
 * out loud in the panel rather than assumed — a gate nobody knows the shape of
 * is not a gate.
 */
import { Router } from "express";
import { adminAllowed } from "../admin-gate.js";
import type { EvalCatalog, EvalFrame } from "../types.js";
import { FIXTURE_EVENTS, FIXTURE_NOW } from "./fixtures.js";
import { personaCards } from "./personas.js";
import { SUITES } from "./registry.js";
import { EvalRunBusy, runEvals, runInProgress } from "./runner.js";
import { history, lastRun, record } from "./history.js";
import { safeDetail } from "./harness.js";

export const evals = Router();

evals.get("/api/evals", async (req, res) => {
  if (!(await adminAllowed(req))) return res.status(403).json({ error: "admin only" });
  try {
    // Counting cases builds them, which is also a cheap check that every
    // fixture still loads — a suite whose cases cannot be built shows as 0
    // here rather than surprising the operator halfway through a run.
    const suites = await Promise.all(
      SUITES.map(async (s) => {
        let caseCount = 0;
        let unavailable: string | undefined;
        try {
          caseCount = (await s.cases()).length;
        } catch (err) {
          unavailable = safeDetail(`cases failed to build: ${String(err)}`);
        }
        if (!unavailable && s.available) {
          unavailable = (await s.available().catch((err) => safeDetail(String(err)))) ?? undefined;
        }
        return {
          id: s.id,
          title: s.title,
          what: s.what,
          kind: s.kind,
          threshold: s.threshold,
          caseCount,
          ...(unavailable && { unavailable }),
        };
      }),
    );
    const catalog: EvalCatalog = {
      suites,
      personas: personaCards(),
      lastRun: lastRun(),
      fixtureNow: FIXTURE_NOW.toISOString(),
      fixtureEvents: FIXTURE_EVENTS.length,
      running: runInProgress(),
    };
    res.json(catalog);
  } catch (err) {
    res.status(500).json({ error: safeDetail(String(err)) });
  }
});

evals.get("/api/evals/history", async (req, res) => {
  if (!(await adminAllowed(req))) return res.status(403).json({ error: "admin only" });
  res.json({ runs: history() });
});

evals.post("/api/evals/run", async (req, res) => {
  if (!(await adminAllowed(req))) return res.status(403).json({ error: "admin only" });

  const only = Array.isArray(req.body?.suites)
    ? req.body.suites.map(String).filter((id: string) => SUITES.some((s) => s.id === id))
    : undefined;

  if (runInProgress()) {
    return res.status(409).json({ error: "an eval run is already in progress" });
  }

  // Headers before the first case, so the browser can render the shell while
  // the run is still working.
  res.setHeader("Content-Type", "application/x-ndjson");
  res.setHeader("Cache-Control", "no-store");
  // Streaming through a proxy that buffers would defeat the whole point.
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  const abort = new AbortController();
  res.on("close", () => abort.abort());

  const write = (frame: EvalFrame) => {
    if (!res.writableEnded) res.write(JSON.stringify(frame) + "\n");
  };

  try {
    const run = await runEvals({
      only,
      // The runner's own "done" frame carries the unstamped run; the stamped
      // one goes out below instead, so the client only ever sees one.
      onFrame: (frame) => {
        if (frame.type !== "done") write(frame);
      },
      signal: abort.signal,
    });
    // A run the client walked away from is incomplete, and recording it would
    // make it the baseline every later run is compared against.
    if (abort.signal.aborted) return;
    // Stamped with regressions/fixes against the last comparable run, so the
    // panel shows what CHANGED, not just what is red.
    write({ type: "done", run: record(run) });
  } catch (err) {
    const message = err instanceof EvalRunBusy ? err.message : safeDetail(String(err));
    write({ type: "error", message });
  } finally {
    if (!res.writableEnded) res.end();
  }
});
