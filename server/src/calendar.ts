/**
 * "My calendar" — the set of events a user saved from the map.
 *
 * Adding an event stores a CalendarEntry and, when Google Calendar is
 * connected, also creates it on their primary calendar (removal deletes it
 * again). Apple Calendar has no public write API, so its path is the
 * personal ICS feed below (subscribe once, adds/removes follow) or the
 * per-event .ics download.
 */
import { Router, type Request, type Response } from "express";
import { sessionUser } from "./auth.js";
import {
  CALENDAR_SCOPE,
  calendarConnected,
  createGoogleEvent,
  deleteGoogleEvent,
  disconnectGoogle,
  insertGoogleEvent,
  listGoogleEvents,
  patchGoogleEvent,
  type GcalEventPatch,
} from "./gcal.js";
import { icsCalendar } from "./ics.js";
import { store } from "./store.js";
import type { User } from "./types.js";

export const calendar = Router();

/** Where feed links should point. Dev default matches the Vite proxy. */
function baseUrl(): string {
  return (process.env.PUBLIC_BASE_URL ?? "http://localhost:5174").replace(/\/$/, "");
}

async function status(user: User) {
  const [entries, feedToken] = await Promise.all([
    store.userCalendar(user.id),
    store.ensureFeedToken(user.id),
  ]);
  return {
    signedIn: true,
    google: calendarConnected(user),
    synced: entries.map((e) => e.eventId),
    feedUrl: `${baseUrl()}/api/calendar/feed/${feedToken}.ics`,
  };
}

const SIGNED_OUT = { signedIn: false, google: false, synced: [], feedUrl: null };

function requireUser(req: Request): Promise<User | null> {
  return sessionUser(req);
}

calendar.get("/api/calendar/status", async (req, res) => {
  const user = await requireUser(req);
  res.json(user ? await status(user) : SIGNED_OUT);
});

/**
 * Save an event for a user, pushing to Google Calendar when connected.
 * Shared by the cookie-authed route below and the external agent API.
 */
export async function saveEventForUser(
  user: User,
  eventId: string,
): Promise<{ googleSynced: boolean; warning?: string } | { error: string; code: 404 }> {
  const event = await store.eventById(eventId);
  if (!event) return { error: "unknown event", code: 404 };

  let entry = await store.upsertCalendarEntry(user.id, event.id);
  let warning: string | undefined;
  if (calendarConnected(user) && !entry.googleEventId) {
    try {
      const tz = (await store.settings()).tz;
      const googleEventId = await insertGoogleEvent(user, event, tz);
      entry = await store.upsertCalendarEntry(user.id, event.id, { googleEventId });
    } catch (err) {
      // Saved locally either way — the feed still serves it; surface the miss.
      warning = String(err).slice(0, 200);
    }
  }
  return { googleSynced: !!entry.googleEventId, ...(warning && { warning }) };
}

/**
 * Remove a saved event, deleting the Google copy when it was synced.
 * Idempotent; a Google delete failure keeps the entry so a retry can clean up.
 */
export async function removeEventForUser(
  user: User,
  eventId: string,
): Promise<{ removed: boolean } | { error: string; code: 502 }> {
  const entry = (await store.userCalendar(user.id)).find((e) => e.eventId === eventId);
  if (!entry) return { removed: false }; // already gone — idempotent

  if (entry.googleEventId && calendarConnected(user)) {
    try {
      await deleteGoogleEvent(user, entry.googleEventId);
    } catch (err) {
      return { error: String(err).slice(0, 200), code: 502 };
    }
  }
  await store.removeCalendarEntry(user.id, eventId);
  return { removed: true };
}

/** Save an event; pushes to Google Calendar too when connected. */
calendar.post("/api/calendar/events/:id", async (req, res) => {
  const user = await requireUser(req);
  if (!user) return res.status(401).json({ error: "not signed in" });
  const result = await saveEventForUser(user, req.params.id);
  if ("error" in result) return res.status(result.code).json({ error: result.error });
  res.json({ ...(await status(user)), ...result });
});

/** Remove a saved event; deletes from Google Calendar when it was synced. */
calendar.delete("/api/calendar/events/:id", async (req, res) => {
  const user = await requireUser(req);
  if (!user) return res.status(401).json({ error: "not signed in" });
  const result = await removeEventForUser(user, req.params.id);
  if ("error" in result) return res.status(result.code).json({ error: result.error });
  res.json(await status(user));
});

// ---------------------------------------------------------------------------
// In-app Google Calendar preview — list/create/edit/delete on the user's
// primary calendar, powering the month/agenda popup.
// ---------------------------------------------------------------------------

/** Resolves the signed-in, Google-connected user or writes the error itself. */
async function googleUser(req: Request, res: Response): Promise<User | null> {
  const user = await requireUser(req);
  if (!user) {
    res.status(401).json({ error: "not signed in" });
    return null;
  }
  if (!calendarConnected(user)) {
    res.status(409).json({ error: "Google Calendar is not connected" });
    return null;
  }
  return user;
}

/** Sanitize the patch body — only known fields, only sane shapes. */
function readPatch(body: unknown): GcalEventPatch {
  const b = (body ?? {}) as Record<string, unknown>;
  const str = (k: string) => (typeof b[k] === "string" ? (b[k] as string) : undefined);
  const attendees = Array.isArray(b.attendees)
    ? (b.attendees as unknown[])
        .map((a) => a as Record<string, unknown>)
        .filter((a) => typeof a.email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a.email as string))
        .slice(0, 100)
        .map((a) => ({
          email: (a.email as string).trim(),
          ...(typeof a.displayName === "string" && { displayName: a.displayName }),
          ...(typeof a.responseStatus === "string" && { responseStatus: a.responseStatus }),
        }))
    : undefined;
  return {
    ...(str("title") !== undefined && { title: str("title")!.slice(0, 300) }),
    ...(str("description") !== undefined && { description: str("description")!.slice(0, 8000) }),
    ...(str("location") !== undefined && { location: str("location")!.slice(0, 1000) }),
    ...(str("start") !== undefined && { start: str("start") }),
    ...(str("end") !== undefined && { end: str("end") }),
    ...(typeof b.allDay === "boolean" && { allDay: b.allDay }),
    ...(str("color") !== undefined && { color: str("color") }),
    ...(typeof b.guestsCanModify === "boolean" && { guestsCanModify: b.guestsCanModify }),
    ...(attendees !== undefined && { attendees }),
  };
}

/**
 * The preview window. Grapevine-synced saves are tagged with their event id
 * so the UI can badge them (and un-save on delete).
 */
calendar.get("/api/calendar/google/events", async (req, res) => {
  const user = await googleUser(req, res);
  if (!user) return;
  const from = typeof req.query.from === "string" ? req.query.from : "";
  const to = typeof req.query.to === "string" ? req.query.to : "";
  if (!Number.isFinite(Date.parse(from)) || !Number.isFinite(Date.parse(to))) {
    return res.status(400).json({ error: "from & to must be ISO dates" });
  }
  try {
    const [events, entries] = await Promise.all([
      listGoogleEvents(user, from, to),
      store.userCalendar(user.id),
    ]);
    const grapevine = new Map(
      entries.filter((e) => e.googleEventId).map((e) => [e.googleEventId!, e.eventId]),
    );
    res.json({
      events: events.map((e) => ({
        ...e,
        ...(grapevine.has(e.id) && { grapevineEventId: grapevine.get(e.id) }),
      })),
    });
  } catch (err) {
    res.status(502).json({ error: String(err).slice(0, 200) });
  }
});

/** "New event" in the popup — a free-form event on the user's calendar. */
calendar.post("/api/calendar/google/events", async (req, res) => {
  const user = await googleUser(req, res);
  if (!user) return;
  const patch = readPatch(req.body);
  if (!patch.title || !patch.start || !patch.end) {
    return res.status(400).json({ error: "title, start and end are required" });
  }
  try {
    res.json(await createGoogleEvent(user, patch, (await store.settings()).tz));
  } catch (err) {
    res.status(502).json({ error: String(err).slice(0, 200) });
  }
});

/**
 * Edit / invite. Guest-list and sharing-mode changes go out with
 * sendUpdates=all so invitees get real Google Calendar emails.
 */
calendar.patch("/api/calendar/google/events/:gid", async (req, res) => {
  const user = await googleUser(req, res);
  if (!user) return;
  const patch = readPatch(req.body);
  if (!Object.keys(patch).length) return res.status(400).json({ error: "empty patch" });
  const notify = patch.attendees !== undefined || patch.guestsCanModify !== undefined;
  try {
    res.json(
      await patchGoogleEvent(
        user,
        req.params.gid,
        patch,
        (await store.settings()).tz,
        notify,
      ),
    );
  } catch (err) {
    res.status(502).json({ error: String(err).slice(0, 200) });
  }
});

/**
 * Remove from Google Calendar. When the event was a Grapevine save, the
 * calendar entry goes too, so the map's "saved" state stays truthful.
 */
calendar.delete("/api/calendar/google/events/:gid", async (req, res) => {
  const user = await googleUser(req, res);
  if (!user) return;
  try {
    await deleteGoogleEvent(user, req.params.gid);
    const entry = (await store.userCalendar(user.id)).find(
      (e) => e.googleEventId === req.params.gid,
    );
    if (entry) await store.removeCalendarEntry(user.id, entry.eventId);
    res.json(await status((await store.userById(user.id)) ?? user));
  } catch (err) {
    res.status(502).json({ error: String(err).slice(0, 200) });
  }
});

/**
 * Connect Google Calendar. The browser runs the incremental-consent OAuth
 * through Supabase (signInWithOAuth with the calendar.events scope +
 * access_type=offline) and posts the provider_refresh_token from the
 * resulting session here; we move it straight into Vault. The token is
 * stored for the *verified* session user — nothing in the body picks the
 * account.
 */
calendar.post("/api/calendar/google/connect", async (req, res) => {
  const user = await requireUser(req);
  if (!user) return res.status(401).json({ error: "not signed in" });
  const refreshToken = typeof req.body?.refreshToken === "string" ? req.body.refreshToken : "";
  const scope = typeof req.body?.scope === "string" ? req.body.scope : CALENDAR_SCOPE;
  if (!refreshToken) return res.status(400).json({ error: "refreshToken required" });
  try {
    await store.setGoogleCalendarToken(user.id, refreshToken, scope);
  } catch (err) {
    return res.status(502).json({ error: String(err).slice(0, 200) });
  }
  const fresh = (await store.userById(user.id)) ?? user;
  // Events saved before Google was connected only lived in the ICS feed —
  // push them to the newly connected calendar so both sides match.
  await backfillGoogleCalendar(fresh);
  res.json(await status(fresh));
});

async function backfillGoogleCalendar(user: User): Promise<void> {
  const tz = (await store.settings()).tz;
  const events = await store.events();
  for (const entry of await store.userCalendar(user.id)) {
    if (entry.googleEventId) continue;
    const event = events.find((e) => e.id === entry.eventId);
    if (!event) continue;
    try {
      const googleEventId = await insertGoogleEvent(user, event, tz);
      await store.upsertCalendarEntry(user.id, entry.eventId, { googleEventId });
    } catch (err) {
      console.error(`[calendar] backfill ${entry.eventId}:`, String(err).slice(0, 160));
    }
  }
}

/**
 * Drop the Google grant. Synced copies stay on the user's calendar (we can't
 * touch them once the token is revoked), so the entries just forget their
 * Google ids.
 */
calendar.post("/api/calendar/google/disconnect", async (req, res) => {
  const user = await requireUser(req);
  if (!user) return res.status(401).json({ error: "not signed in" });
  await disconnectGoogle(user);
  await store.clearGoogleEventIds(user.id);
  const fresh = await store.userById(user.id);
  res.json(fresh ? await status(fresh) : SIGNED_OUT);
});

/**
 * Personal ICS feed — subscribe from Apple Calendar (or anything that speaks
 * webcal). Auth is the unguessable token in the path; calendar apps can't
 * send cookies.
 */
calendar.get("/api/calendar/feed/:token", async (req, res) => {
  const token = req.params.token.replace(/\.ics$/, "");
  const user = await store.userByFeedToken(token);
  if (!user) return res.status(404).send("not found");
  const events = await store.events();
  const mine = (await store.userCalendar(user.id))
    .map((entry) => events.find((e) => e.id === entry.eventId))
    .filter((e): e is NonNullable<typeof e> => !!e);
  res.setHeader("Content-Type", "text/calendar; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.send(icsCalendar(mine, "Grapevine"));
});

/** Single-event .ics — the universal "Add to Apple Calendar" fallback. */
calendar.get("/api/events/:id/ics", async (req, res) => {
  const event = await store.eventById(req.params.id);
  if (!event) return res.status(404).json({ error: "unknown event" });
  const slug = event.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40) || "event";
  res.setHeader("Content-Type", "text/calendar; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${slug}.ics"`);
  res.send(icsCalendar([event], "Grapevine"));
});
