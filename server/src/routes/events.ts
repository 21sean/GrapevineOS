/**
 * The event catalog as the browser reads it, plus the per-user reactions
 * that teach the ranking. Re-rating is admin-only: it spends a model call.
 */
import { Router } from "express";
import { requireAdmin, sessionUser } from "../auth.js";
import { rateEvent } from "../ingest.js";
import { store } from "../store.js";
import { REACTIONS, type Reaction } from "../types.js";

export const events = Router();

events.get("/api/events", async (_req, res) => {
  try {
    res.json(await store.events());
  } catch (err) {
    res.status(502).json({ error: String(err) });
  }
});

events.post("/api/events/:id/rate", requireAdmin, async (req, res) => {
  const event = await store.eventById(String(req.params.id));
  if (!event) return res.status(404).json({ error: "unknown event" });
  try {
    const r = await rateEvent(event);
    const updated = await store.updateEvent(event.id, {
      rating: r.rating,
      ratingRationale: r.rationale,
      promoted: r.promoted,
    });
    res.json(updated);
  } catch (err) {
    res.status(502).json({ error: String(err) });
  }
});

// ---------- reactions (per-user feedback loop) ----------

events.get("/api/reactions", async (req, res) => {
  const user = await sessionUser(req);
  if (!user) return res.status(401).json({ error: "not signed in" });
  try {
    res.json({ reactions: await store.userReactions(user.id) });
  } catch (err) {
    res.status(502).json({ error: String(err) });
  }
});

/** Set or clear (reaction: null) the caller's reaction to an event. */
events.put("/api/events/:id/reaction", async (req, res) => {
  const user = await sessionUser(req);
  if (!user) return res.status(401).json({ error: "not signed in" });
  const reaction = req.body?.reaction ?? null;
  if (reaction !== null && !REACTIONS.includes(reaction)) {
    return res
      .status(400)
      .json({ error: `reaction must be null or one of: ${REACTIONS.join(", ")}` });
  }
  const event = await store.eventById(String(req.params.id));
  if (!event) return res.status(404).json({ error: "unknown event" });
  try {
    await store.setReaction(user.id, event.id, reaction as Reaction | null);
    res.json({ ok: true, eventId: event.id, reaction });
  } catch (err) {
    res.status(502).json({ error: String(err) });
  }
});
