/**
 * Ingestion over HTTP: pasted newsletters (preview, then commit), the ingest
 * history, the image backfill, and the kick the email worker sends after it
 * inserts a raw email. Everything but the kick is admin-only; the kick is
 * guarded by the shared ingest key.
 */
import { Router } from "express";
import { requireAdmin } from "../auth.js";
import { backfillImages } from "../images.js";
import { kickInbox } from "../inbox.js";
import { extractEvents } from "../ingest.js";
import { commitIngest } from "../pipeline.js";
import { safeEqual } from "../secrets.js";
import { store } from "../store.js";
import type { CityEvent } from "../types.js";

export const ingest = Router();

/** Clear shared/generic banners, then scrape og:images for events without art. */
ingest.post("/api/ingest/backfill-images", requireAdmin, async (_req, res) => {
  try {
    res.json(await backfillImages());
  } catch (err) {
    res.status(502).json({ error: String(err) });
  }
});

/** Newest-first log of every email/paste that went through the pipeline. */
ingest.get("/api/ingest/history", requireAdmin, async (_req, res) => {
  try {
    res.json(await store.ingests());
  } catch (err) {
    res.status(502).json({ error: String(err) });
  }
});

/** Extract events from pasted/forwarded email text. dryRun previews only. */
ingest.post("/api/ingest/email", requireAdmin, async (req, res) => {
  const { text, source = "manual" } = req.body ?? {};
  const dry = req.body?.dryRun === true || req.body?.dry_run === true;
  if (!text) return res.status(400).json({ error: "text required" });
  try {
    // Pasted text is a manual entry: the stored events and the ingest log
    // agree on provenance (both "manual").
    const events = await extractEvents({ text, source, sourceKind: "manual" });
    if (dry) return res.json({ events, added: 0 });
    const { added } = await commitIngest({ events, source, kind: "manual" });
    res.json({ events, added: added.length });
  } catch (err) {
    res.status(502).json({ error: String(err) });
  }
});

/** Commit previously previewed events (email pastes and discovery dry runs). */
ingest.post("/api/ingest/commit", requireAdmin, async (req, res) => {
  const events: CityEvent[] = req.body?.events ?? [];
  if (!Array.isArray(events) || !events.length) {
    return res.status(400).json({ error: "events[] required" });
  }
  try {
    const { added } = await commitIngest({
      events,
      source: events[0]?.source ?? "manual",
      kind: events[0]?.sourceKind === "search" ? "search" : "manual",
    });
    res.json({ added: added.length });
  } catch (err) {
    res.status(502).json({ error: String(err) });
  }
});

/**
 * Kick endpoint the Cloudflare Email Worker pings (when this server is
 * reachable from the worker) right after it inserts the email into
 * raw_emails. The worker's insert is the durable ledger; this just wakes the
 * processor so extraction runs on arrival instead of on a timer.
 * Fire-and-forget: the worker is not blocked on the local model, and the
 * row's processed_at/retry state owns durability. Guarded by a shared key.
 */
ingest.post("/api/ingest/inbound", (req, res) => {
  if (!safeEqual(req.get("X-Ingest-Key"), process.env.INGEST_SHARED_KEY)) {
    return res.status(401).json({ error: "bad ingest key" });
  }
  kickInbox();
  res.json({ ok: true, queued: true });
});
