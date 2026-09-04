/**
 * Server types. The domain shapes the web client also consumes live in
 * shared/types.ts (one definition, re-exported here); this file adds the
 * server-only shapes (auth, push, calendar grants) that never cross the wire
 * to the browser as-is.
 */
import type { Reaction, User as PublicUser } from "../../shared/types.js";

export * from "../../shared/types.js";

export interface ReactionEntry {
  eventId: string;
  reaction: Reaction;
}

/** One browser that enabled Web Push for a user. */
export interface PushSub {
  id: string;
  userId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  reminders: boolean;
  weeklyDigest: boolean;
  /** Traffic-aware "time to leave" alerts for going/saved events. */
  leaveBy: boolean;
  /** Opt-in: a push when ingest lands a rare event matching the user's loves. */
  rareFinds: boolean;
}

/**
 * Google Calendar connection metadata. The refresh token itself lives in
 * Supabase Vault (encrypted at rest) and is only read through the
 * google_calendar_get RPC; this is the non-secret shape rows join with.
 */
export interface GoogleCalendarGrant {
  scope: string;
}

/**
 * One event a user saved to their calendar. googleEventId is set once the
 * entry has been pushed to their Google Calendar; the ICS feed serves the
 * same set to Apple Calendar and friends.
 */
export interface CalendarEntry {
  userId: string;
  eventId: string;
  googleEventId?: string;
  addedAt: string; // ISO 8601
}

/** The public user shape, plus what only the server may see. */
export interface User extends PublicUser {
  googleCalendar?: GoogleCalendarGrant; // present once Google Calendar is connected
  feedToken?: string; // unguessable path segment for the personal ICS feed
  /** Last coarse position (~110 m grid) the browser reported: the origin for
   * leave-by ETAs. Absent until the user grants geolocation while signed in. */
  lastPos?: { lng: number; lat: number; at: string };
}
