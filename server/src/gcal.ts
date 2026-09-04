/**
 * Google Calendar API v3 — insert/delete events on the signed-in user's
 * primary calendar. The refresh token comes from the incremental consent
 * flow (supabase-js signInWithOAuth with the calendar.events scope +
 * offline access) and lives encrypted in Supabase Vault; short-lived access
 * tokens are minted from it here and cached in memory only.
 */
import { calendarEventBody } from "./calendar-body.js";
import { store } from "./store.js";
import type { CityEvent, GcalEvent, GcalEventPatch, User } from "./types.js";

export type { GcalEvent, GcalEventPatch };

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const EVENTS_URL = "https://www.googleapis.com/calendar/v3/calendars/primary/events";

export const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.events";

export function calendarConnected(user: User): boolean {
  return !!user.googleCalendar;
}

/**
 * Turns a Google Calendar API failure into a one-line message. Google wraps
 * errors as {error:{message}}; surfacing that (e.g. "Google Calendar API has
 * not been used in project … Enable it …") beats dumping raw JSON at the user.
 */
async function gcalError(res: Response, verb: string): Promise<Error> {
  const body = await res.text().catch(() => "");
  let message = body.slice(0, 200);
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } };
    if (parsed.error?.message) message = parsed.error.message;
  } catch {
    /* not JSON — keep the truncated text */
  }
  return new Error(`Google Calendar ${verb} failed (${res.status}): ${message}`);
}

/**
 * Access tokens are short-lived (~1h) and deliberately never persisted —
 * only the Vault-encrypted refresh token survives a restart. One refresh
 * round trip per user per process lifetime (then per expiry) is free-tier
 * noise, and it keeps bearer tokens out of the database entirely.
 */
const accessTokens = new Map<string, { token: string; expiresAt: number }>();

/** Valid access token for the user, minting one from the refresh token. */
async function accessToken(user: User): Promise<string> {
  const cached = accessTokens.get(user.id);
  if (cached && cached.expiresAt - 60_000 > Date.now()) return cached.token;

  const grant = await store.googleCalendarToken(user.id);
  if (!grant) throw new Error("Google Calendar is not connected");

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID ?? "",
      client_secret: process.env.GOOGLE_CLIENT_SECRET ?? "",
      refresh_token: grant.refreshToken,
      grant_type: "refresh_token",
    }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    throw new Error(`token refresh failed: ${(await res.text()).slice(0, 200)}`);
  }
  const body = (await res.json()) as { access_token: string; expires_in: number };
  const next = { token: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
  accessTokens.set(user.id, next);
  return next.token;
}

function gcalBody(e: CityEvent, tz: string) {
  const { description, location } = calendarEventBody(e);
  return {
    summary: e.title,
    location,
    description,
    start: { dateTime: e.start, timeZone: tz },
    end: { dateTime: e.end, timeZone: tz },
    // Google expands the RRULE from the anchor occurrence, same as Apple/ICS.
    ...(e.recurrence && { recurrence: [`RRULE:${e.recurrence}`] }),
  };
}

/** Creates the event on the user's primary calendar; returns Google's id. */
export async function insertGoogleEvent(
  user: User,
  event: CityEvent,
  tz: string,
): Promise<string> {
  const token = await accessToken(user);
  const res = await fetch(EVENTS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(gcalBody(event, tz)),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    throw new Error(`calendar insert ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  return ((await res.json()) as { id: string }).id;
}

// ---------------------------------------------------------------------------
// Full calendar client — the in-app preview (list/create/edit/invite) works
// on the user's primary calendar through the same events scope as the sync.
// ---------------------------------------------------------------------------

/** Etiquette color (the web's palette) ↔ Google colorId. */
const COLOR_TO_ID: Record<string, string> = {
  sky: "7", // Peacock
  amber: "5", // Banana
  violet: "3", // Grape
  rose: "4", // Flamingo
  emerald: "10", // Basil
  orange: "6", // Tangerine
};
const ID_TO_COLOR: Record<string, string> = {
  "1": "violet", // Lavender
  "2": "emerald", // Sage
  "3": "violet",
  "4": "rose",
  "5": "amber",
  "6": "orange",
  "7": "sky",
  "8": "sky", // Graphite
  "9": "sky", // Blueberry
  "10": "emerald",
  "11": "rose", // Tomato
};

interface RawGcalTime {
  date?: string; // all-day: YYYY-MM-DD
  dateTime?: string;
  timeZone?: string;
}

interface RawGcalEvent {
  id: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  colorId?: string;
  htmlLink?: string;
  start?: RawGcalTime;
  end?: RawGcalTime;
  recurringEventId?: string;
  guestsCanModify?: boolean;
  organizer?: { email?: string; displayName?: string; self?: boolean };
  attendees?: {
    email?: string;
    displayName?: string;
    responseStatus?: string;
    organizer?: boolean;
    self?: boolean;
    optional?: boolean;
    resource?: boolean;
  }[];
}

/** The shape the web calendar renders — times stay ISO, colors are palette names. */
/** Fields the web can set on create/update; times are ISO (or YYYY-MM-DD all-day). */
function toWebEvent(r: RawGcalEvent, user: User): GcalEvent {
  const allDay = !!r.start?.date;
  const isOrganizer = !!r.organizer?.self || r.organizer?.email === user.email;
  return {
    id: r.id,
    title: r.summary ?? "(no title)",
    description: r.description ?? "",
    location: r.location ?? "",
    start: r.start?.dateTime ?? r.start?.date ?? "",
    end: r.end?.dateTime ?? r.end?.date ?? "",
    allDay,
    color: (r.colorId && ID_TO_COLOR[r.colorId]) || "sky",
    htmlLink: r.htmlLink ?? "",
    canEdit: isOrganizer || !!r.guestsCanModify,
    guestsCanModify: !!r.guestsCanModify,
    organizerEmail: r.organizer?.email ?? "",
    attendees: (r.attendees ?? [])
      .filter((a) => a.email && !a.resource)
      .map((a) => ({
        email: a.email!,
        displayName: a.displayName,
        responseStatus: a.responseStatus ?? "needsAction",
        organizer: !!a.organizer,
        self: !!a.self,
      })),
    ...(r.recurringEventId && { recurringEventId: r.recurringEventId }),
  };
}

/** Google's start/end objects from ISO strings; all-day uses exclusive dates. */
function toGcalTimes(start: string, end: string, allDay: boolean, tz: string) {
  if (allDay) {
    return {
      start: { date: start.slice(0, 10) },
      end: { date: end.slice(0, 10) },
    };
  }
  return {
    start: { dateTime: start, timeZone: tz },
    end: { dateTime: end, timeZone: tz },
  };
}

function patchToBody(patch: GcalEventPatch, tz: string): Record<string, unknown> {
  return {
    ...(patch.title !== undefined && { summary: patch.title }),
    ...(patch.description !== undefined && { description: patch.description }),
    ...(patch.location !== undefined && { location: patch.location }),
    ...(patch.start !== undefined &&
      patch.end !== undefined &&
      toGcalTimes(patch.start, patch.end, !!patch.allDay, tz)),
    ...(patch.color !== undefined && { colorId: COLOR_TO_ID[patch.color] ?? null }),
    ...(patch.guestsCanModify !== undefined && { guestsCanModify: patch.guestsCanModify }),
    ...(patch.attendees !== undefined && {
      attendees: patch.attendees.map((a) => ({
        email: a.email,
        ...(a.displayName && { displayName: a.displayName }),
        ...(a.responseStatus && { responseStatus: a.responseStatus }),
      })),
    }),
  };
}

/**
 * Events on the user's primary calendar inside [from, to). Recurring series
 * come back expanded into single occurrences, ordered by start.
 */
export async function listGoogleEvents(
  user: User,
  from: string,
  to: string,
): Promise<GcalEvent[]> {
  const token = await accessToken(user);
  const params = new URLSearchParams({
    timeMin: new Date(from).toISOString(),
    timeMax: new Date(to).toISOString(),
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: "250",
  });
  const res = await fetch(`${EVENTS_URL}?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw await gcalError(res, "list");
  const body = (await res.json()) as { items?: RawGcalEvent[] };
  return (body.items ?? [])
    .filter((r) => r.status !== "cancelled")
    .map((r) => toWebEvent(r, user));
}

/**
 * Creates a free-form event (the popup's "New event"), unlike insertGoogleEvent
 * which pushes a Grapevine CityEvent. sendUpdates emails any listed attendees.
 */
export async function createGoogleEvent(
  user: User,
  patch: GcalEventPatch,
  tz: string,
): Promise<GcalEvent> {
  const token = await accessToken(user);
  const res = await fetch(`${EVENTS_URL}?sendUpdates=all`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(patchToBody(patch, tz)),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw await gcalError(res, "create");
  return toWebEvent((await res.json()) as RawGcalEvent, user);
}

/**
 * Patches an event in place. notify=true (used whenever the guest list or
 * sharing mode changes) makes Google send real invite emails.
 */
export async function patchGoogleEvent(
  user: User,
  googleEventId: string,
  patch: GcalEventPatch,
  tz: string,
  notify = false,
): Promise<GcalEvent> {
  const token = await accessToken(user);
  const params = notify ? "?sendUpdates=all" : "";
  const res = await fetch(`${EVENTS_URL}/${encodeURIComponent(googleEventId)}${params}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(patchToBody(patch, tz)),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw await gcalError(res, "update");
  return toWebEvent((await res.json()) as RawGcalEvent, user);
}

/** Deletes by Google event id. Already-gone (404/410) counts as success. */
export async function deleteGoogleEvent(user: User, googleEventId: string): Promise<void> {
  const token = await accessToken(user);
  const res = await fetch(`${EVENTS_URL}/${encodeURIComponent(googleEventId)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok && res.status !== 404 && res.status !== 410) {
    throw new Error(`calendar delete ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
}

/** Revokes the grant at Google (best effort) and scrubs the Vault secret. */
export async function disconnectGoogle(user: User): Promise<void> {
  const grant = await store.googleCalendarToken(user.id).catch(() => null);
  if (grant) {
    await fetch(`${REVOKE_URL}?token=${encodeURIComponent(grant.refreshToken)}`, {
      method: "POST",
      signal: AbortSignal.timeout(10000),
    }).catch(() => {});
  }
  accessTokens.delete(user.id);
  await store.clearGoogleCalendarToken(user.id);
}
