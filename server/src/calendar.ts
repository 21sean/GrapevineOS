/**
 * "My calendar" — the set of events a user saved from the map.
 *
 * Adding an event stores a CalendarEntry and, when Google Calendar is
 * connected, also creates it on their primary calendar (removal deletes it
 * again). Apple Calendar has no public write API, so its path is the
 * personal ICS feed below (subscribe once, adds/removes follow) or the
 * per-event .ics download.
 */
import { Router, type Request } from "express";
import { sessionUser } from "./auth.js";
import {
  calendarConnected,
  deleteGoogleEvent,
  disconnectGoogle,
  insertGoogleEvent,
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

/** Save an event; pushes to Google Calendar too when connected. */
calendar.post("/api/calendar/events/:id", async (req, res) => {
  const user = await requireUser(req);
  if (!user) return res.status(401).json({ error: "not signed in" });
  const event = await store.eventById(req.params.id);
  if (!event) return res.status(404).json({ error: "unknown event" });

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
  res.json({
    ...(await status(user)),
    googleSynced: !!entry.googleEventId,
    ...(warning && { warning }),
  });
});

/** Remove a saved event; deletes from Google Calendar when it was synced. */
calendar.delete("/api/calendar/events/:id", async (req, res) => {
  const user = await requireUser(req);
  if (!user) return res.status(401).json({ error: "not signed in" });
  const entry = (await store.userCalendar(user.id)).find(
    (e) => e.eventId === req.params.id,
  );
  if (!entry) return res.json(await status(user)); // already gone — idempotent

  if (entry.googleEventId && calendarConnected(user)) {
    try {
      await deleteGoogleEvent(user, entry.googleEventId);
    } catch (err) {
      // Keep the entry so a retry can still clean up the Google copy.
      return res.status(502).json({ error: String(err).slice(0, 200) });
    }
  }
  await store.removeCalendarEntry(user.id, req.params.id);
  res.json(await status(user));
});

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
