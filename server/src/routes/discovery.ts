/**
 * Web discovery over HTTP, once. Mounted twice: under /api/discovery behind
 * the admin gate for the web app, and under /api/ext/v1/discovery behind the
 * agent key for external assistants. Same handlers, same contract schemas,
 * same error shapes (the error handler in request-id.ts); only the auth
 * adapter differs.
 */
import { Router, type RequestHandler } from "express";
import { parseArgs } from "../agent/contracts.js";
import { clampCadence, runDiscovery, runSavedSearch, wantsCommit } from "../discovery.js";
import { store } from "../store.js";

export function discoveryRouter(auth: RequestHandler): Router {
  const r = Router();
  r.use(auth);

  /**
   * Run one search now. Dry run by default on every surface: committing
   * machine-verified events to the map is always an explicit dry_run:false
   * (the older dryRun spelling still counts).
   */
  r.post("/run", async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const parsed = parseArgs("discover_events", { ...body, dry_run: !wantsCommit(body) });
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });
    res.json(
      await runDiscovery({ query: parsed.args.query, commit: parsed.args.dry_run === false }),
    );
  });

  r.get("/searches", async (_req, res) => {
    res.json({ searches: await store.discoverySearches() });
  });

  /** Save (or update, keyed on the query) a scheduled search. */
  r.post("/searches", async (req, res) => {
    const parsed = parseArgs("schedule_search", req.body);
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });
    res.json(
      await store.addDiscoverySearch(parsed.args.query, clampCadence(parsed.args.cadence_hours)),
    );
  });

  /** Pause, resume, or re-pace one search. */
  r.patch("/searches/:id", async (req, res) => {
    const parsed = parseArgs("update_scheduled_search", { ...(req.body ?? {}), id: req.params.id });
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });
    const { active, cadence_hours } = parsed.args;
    if (active === undefined && cadence_hours === undefined) {
      return res.status(400).json({ error: "nothing to update (active, cadence_hours)" });
    }
    const updated = await store.updateDiscoverySearch(parsed.args.id, {
      ...(active !== undefined && { active }),
      ...(cadence_hours !== undefined && { cadenceHours: clampCadence(cadence_hours) }),
    });
    if (!updated) return res.status(404).json({ error: "unknown search" });
    res.json(updated);
  });

  r.delete("/searches/:id", async (req, res) => {
    const deleted = await store.deleteDiscoverySearch(String(req.params.id));
    if (!deleted) return res.status(404).json({ error: "unknown search" });
    res.json({ ok: true });
  });

  /** Run one saved search immediately (also stamps last_run and status). */
  r.post("/searches/:id/run", async (req, res) => {
    const search = await store.discoverySearchById(String(req.params.id));
    if (!search) return res.status(404).json({ error: "unknown search" });
    res.json(await runSavedSearch(search));
  });

  return r;
}
