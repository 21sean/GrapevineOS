/**
 * Google Calendar API v3 — insert/delete events on the signed-in user's
 * primary calendar. Tokens come from the incremental consent flow in auth.ts
 * (calendar.events scope, offline access) and are refreshed here on expiry.
 */
import { store } from "./store.js";
import type { CityEvent, User } from "./types.js";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const EVENTS_URL = "https://www.googleapis.com/calendar/v3/calendars/primary/events";

export const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.events";

export function calendarConnected(user: User): boolean {
  return !!user.google?.refreshToken;
}

/** Valid access token for the user, refreshing (and persisting) if expired. */
async function accessToken(user: User): Promise<string> {
  const t = user.google;
  if (!t?.refreshToken) throw new Error("Google Calendar is not connected");
  if (t.accessToken && t.expiresAt - 60_000 > Date.now()) return t.accessToken;

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID ?? "",
      client_secret: process.env.GOOGLE_CLIENT_SECRET ?? "",
      refresh_token: t.refreshToken,
      grant_type: "refresh_token",
    }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    throw new Error(`token refresh failed: ${(await res.text()).slice(0, 200)}`);
  }
  const body = (await res.json()) as { access_token: string; expires_in: number };
  const next = {
    ...t,
    accessToken: body.access_token,
    expiresAt: Date.now() + body.expires_in * 1000,
  };
  await store.setGoogleTokens(user.id, next);
  user.google = next; // keep the in-flight request's copy current too
  return next.accessToken;
}

function gcalBody(e: CityEvent, tz: string) {
  const description = [
    e.description,
    e.ticketUrl ? `Tickets: ${e.ticketUrl}` : "",
    `via Grapevine (${e.source})`,
  ]
    .filter(Boolean)
    .join("\n\n");
  return {
    summary: e.title,
    location: e.address ? `${e.venue}, ${e.address}` : e.venue,
    description,
    start: { dateTime: e.start, timeZone: tz },
    end: { dateTime: e.end, timeZone: tz },
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

/** Revokes the grant at Google (best effort) and drops the stored tokens. */
export async function disconnectGoogle(user: User): Promise<void> {
  const t = user.google;
  if (t) {
    await fetch(`${REVOKE_URL}?token=${encodeURIComponent(t.refreshToken)}`, {
      method: "POST",
      signal: AbortSignal.timeout(10000),
    }).catch(() => {});
  }
  await store.setGoogleTokens(user.id, null);
}
