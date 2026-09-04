/**
 * The external tools API, /api/ext/v1/*: the same executors behind an
 * X-Agent-Key header for assistants that speak REST rather than MCP
 * (OpenClaw and friends). Writes bind to the account named by
 * AGENT_USER_EMAIL, never to anything the caller says.
 *
 * Every route parses its input with the contract in contracts.ts, so a
 * query string, a JSON body and an MCP call validate the same way and fail
 * with the same message. The generated skill file
 * (openclaw/skills/grapevine/SKILL.md) documents exactly these routes.
 */
import { Router, type NextFunction, type Request, type Response } from "express";
import { removeEventForUser, saveEventForUser } from "../calendar.js";
import { discoveryRouter } from "../routes/discovery.js";
import { safeEqual } from "../secrets.js";
import type { User } from "../types.js";
import { CONTRACTS, LNG_LAT_STRING, coerceQuery, parseArgs } from "./contracts.js";
import {
  applyInterests,
  boundAgentUser,
  buildCtx,
  getEta,
  getEvent,
  interestsPreview,
  parseInterestPatch,
  savedEvents,
  searchEvents,
  setEventRarity,
} from "./context.js";

export const ext = Router();

function extAuth(req: Request, res: Response, next: NextFunction) {
  const key = process.env.AGENT_API_KEY;
  if (!key) {
    return res
      .status(503)
      .json({ error: "external agent API disabled: set AGENT_API_KEY in server/.env" });
  }
  if (!safeEqual(req.get("X-Agent-Key"), key)) {
    return res.status(401).json({ error: "bad agent key" });
  }
  next();
}

/** The account external writes act on: bound by env, not by the caller. */
async function extUser(res: Response): Promise<User | null> {
  const user = await boundAgentUser();
  if ("error" in user) {
    res.status(503).json({ error: user.error });
    return null;
  }
  return user;
}

const upstream = (res: Response, err: unknown) =>
  res.status(502).json({ error: String(err).slice(0, 300) });

// ---------- events ----------

ext.get("/api/ext/v1/events", extAuth, async (req, res) => {
  const q = req.query as Record<string, unknown>;
  // The first skill file used shorter names; they keep working.
  const aliased = {
    ...q,
    query: q.query ?? q.q,
    categories: q.categories ?? q.category,
    date_from: q.date_from ?? q.from,
    date_to: q.date_to ?? q.to,
    free_only: q.free_only ?? q.free,
  };
  const parsed = parseArgs(
    "search_events",
    coerceQuery(CONTRACTS.search_events.schema, aliased),
  );
  if (!parsed.ok) return res.status(400).json({ error: parsed.error });
  try {
    const ctx = await buildCtx();
    const result = await searchEvents(parsed.args, ctx);
    res.json({ city: ctx.settings.city, tz: ctx.settings.tz, ...result });
  } catch (err) {
    upstream(res, err);
  }
});

ext.get("/api/ext/v1/events/:id", extAuth, async (req, res) => {
  const parsed = parseArgs("get_event", { id: req.params.id });
  if (!parsed.ok) return res.status(400).json({ error: parsed.error });
  try {
    const ctx = await buildCtx();
    const result = getEvent(parsed.args.id, ctx);
    if ("error" in result) return res.status(404).json(result);
    res.json(result);
  } catch (err) {
    upstream(res, err);
  }
});

/** Correct an event's rarity (drives the app's "Rare finds" filter). */
ext.post("/api/ext/v1/events/:id/rarity", extAuth, async (req, res) => {
  const parsed = parseArgs("set_rarity", { event_id: req.params.id, rarity: req.body?.rarity });
  if (!parsed.ok) return res.status(400).json({ error: parsed.error });
  try {
    const ctx = await buildCtx();
    const result = await setEventRarity(parsed.args.event_id, parsed.args.rarity, ctx);
    if ("error" in result) return res.status(400).json(result);
    res.json({
      id: result.event.id,
      title: result.event.title,
      rarity: result.event.rarity,
      changed: result.changed,
    });
  } catch (err) {
    upstream(res, err);
  }
});

ext.get("/api/ext/v1/eta", extAuth, async (req, res) => {
  const q = req.query as Record<string, unknown>;
  // `to` was documented as "an event id or lng,lat"; sort it into the
  // contract's two fields so the schema does the rest.
  const to = typeof q.to === "string" ? q.to : "";
  const raw = {
    to_event_id: q.to_event_id ?? (to && !LNG_LAT_STRING.test(to) ? to : undefined),
    to: LNG_LAT_STRING.test(to) ? to : undefined,
    from: q.from,
  };
  const parsed = parseArgs("get_eta", raw);
  if (!parsed.ok) return res.status(400).json({ error: parsed.error });
  try {
    const ctx = await buildCtx();
    const result = await getEta(parsed.args, ctx);
    if ("error" in result) return res.status(400).json(result);
    res.json(result);
  } catch (err) {
    upstream(res, err);
  }
});

// ---------- calendar (acts on the bound account) ----------

ext.get("/api/ext/v1/calendar", extAuth, async (_req, res) => {
  try {
    const user = await extUser(res);
    if (!user) return;
    res.json(await savedEvents(user, await buildCtx()));
  } catch (err) {
    upstream(res, err);
  }
});

ext.post("/api/ext/v1/calendar/:eventId", extAuth, async (req, res) => {
  const parsed = parseArgs("save_event", { event_id: req.params.eventId });
  if (!parsed.ok) return res.status(400).json({ error: parsed.error });
  try {
    const user = await extUser(res);
    if (!user) return;
    const result = await saveEventForUser(user, parsed.args.event_id);
    if ("error" in result) return res.status(result.code).json({ error: result.error });
    res.json({ saved: true, ...result });
  } catch (err) {
    upstream(res, err);
  }
});

ext.delete("/api/ext/v1/calendar/:eventId", extAuth, async (req, res) => {
  const parsed = parseArgs("unsave_event", { event_id: req.params.eventId });
  if (!parsed.ok) return res.status(400).json({ error: parsed.error });
  try {
    const user = await extUser(res);
    if (!user) return;
    const result = await removeEventForUser(user, parsed.args.event_id);
    if ("error" in result) return res.status(result.code).json({ error: result.error });
    res.json(result);
  } catch (err) {
    upstream(res, err);
  }
});

// ---------- web discovery (one router, shared with the admin surface) ----------

ext.use("/api/ext/v1/discovery", discoveryRouter(extAuth));

// ---------- interests: propose, then apply with confirmed:true ----------

/**
 * Without confirmed:true this only computes what the change would do and
 * hands it back, the way the in-app card does. With it, the change is
 * written. One policy on every surface: the person sees the proposal first.
 */
ext.post("/api/ext/v1/interests", extAuth, async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const confirmed = body.confirmed === true;
  const parsed = confirmed ? parseArgs("apply_interests", body) : parseArgs("update_interests", body);
  if (!parsed.ok) return res.status(400).json({ error: parsed.error });
  try {
    const user = await extUser(res);
    if (!user) return;
    const patch = parseInterestPatch(parsed.args as Record<string, unknown>);
    if (!confirmed) {
      const preview = await interestsPreview(user, patch);
      if ("error" in preview) return res.status(400).json(preview);
      return res.json({
        ...preview,
        confirmed: false,
        note: "Nothing written. Show this to the user; re-send the same body with confirmed:true once they agree.",
      });
    }
    const result = await applyInterests(user, patch);
    if ("error" in result) return res.status(400).json(result);
    res.json({
      ...result,
      confirmed: true,
      note: "an open Grapevine tab picks this up on its next page load",
    });
  } catch (err) {
    upstream(res, err);
  }
});
