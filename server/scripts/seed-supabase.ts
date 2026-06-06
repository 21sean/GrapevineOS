/**
 * One-time data migration: loads the legacy server/data/*.json stores into
 * Supabase. Idempotent — every insert is an upsert keyed on the natural
 * unique column, so re-running it never duplicates rows.
 *
 *   npm --prefix server run seed:supabase
 *
 * Needs SUPABASE_URL and SUPABASE_SECRET_KEY in server/.env.
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { db } from "../src/db.js";
import { eventKey } from "../src/store.js";
import type {
  CalendarEntry,
  CityEvent,
  IngestRecord,
  Session,
  Settings,
  Source,
  User,
} from "../src/types.js";

const DATA_DIR = path.resolve(import.meta.dirname, "../data");

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), "utf8")) as T;
  } catch {
    return fallback;
  }
}

const sources = readJson<Source[]>("sources.json", []);
const events = readJson<CityEvent[]>("events.json", []);
const users = readJson<User[]>("users.json", []);
const sessions = readJson<Session[]>("sessions.json", []);
const settings = readJson<Settings | null>("settings.json", null);
const calendarEntries = readJson<CalendarEntry[]>("calendar.json", []);
const ingests = readJson<IngestRecord[]>("ingests.json", []);
const geocache = readJson<Record<string, { lng: number; lat: number; name: string } | null>>(
  "geocache.json",
  {},
);

// sources.json entries plus any slug events reference that isn't registered.
const known = new Set(sources.map((s) => s.id));
const derived = [...new Set(events.map((e) => e.source))].filter((s) => !known.has(s));
await db
  .from("sources")
  .upsert(
    [
      ...sources.map((s) => ({
        id: s.id,
        name: s.name,
        address: s.address,
        kind: s.kind,
        note: s.note,
        active: s.active,
      })),
      ...derived.map((id) => ({
        id,
        name: id,
        kind: "derived",
        note: "Auto-registered from ingested events during the JSON migration.",
        active: false,
      })),
    ],
    { onConflict: "id", ignoreDuplicates: true },
  )
  .throwOnError();
console.log(`sources: ${sources.length} + ${derived.length} derived`);

await db
  .from("events")
  .upsert(
    events.map((e) => ({
      id: e.id,
      title: e.title,
      description: e.description,
      category: e.category,
      tags: e.tags,
      venue: e.venue,
      address: e.address ?? null,
      lng: e.lng,
      lat: e.lat,
      starts_at: e.start,
      ends_at: new Date(e.end) >= new Date(e.start) ? e.end : e.start,
      price: e.price,
      is_free: e.free,
      ticket_url: e.ticketUrl ?? null,
      ticket_provider: e.ticketProvider ?? null,
      source_id: e.source,
      source_kind: e.sourceKind,
      rating: e.rating,
      rating_rationale: e.ratingRationale ?? null,
      promoted: e.promoted,
      rarity: e.rarity,
      dedupe_key: eventKey(e),
    })),
    { onConflict: "dedupe_key", ignoreDuplicates: true },
  )
  .throwOnError();
console.log(`events: ${events.length}`);

for (const u of users) {
  await db
    .from("users")
    .upsert(
      {
        id: u.id,
        google_id: u.googleId,
        email: u.email,
        name: u.name,
        picture: u.picture,
        prefs: (u.prefs ?? {}) as never,
        feed_token: u.feedToken ?? null,
        created_at: u.createdAt,
        last_login_at: u.lastLoginAt,
      },
      { onConflict: "google_id", ignoreDuplicates: true },
    )
    .throwOnError();
  if (u.google) {
    await db
      .from("user_google_tokens")
      .upsert({
        user_id: u.id,
        access_token: u.google.accessToken,
        refresh_token: u.google.refreshToken,
        expires_at: new Date(u.google.expiresAt).toISOString(),
        scope: u.google.scope,
      })
      .throwOnError();
  }
}
console.log(`users: ${users.length}`);

const liveSessions = sessions.filter((s) => s.expiresAt > Date.now());
if (liveSessions.length) {
  await db
    .from("sessions")
    .upsert(
      liveSessions.map((s) => ({
        token_hash: s.tokenHash,
        user_id: s.userId,
        expires_at: new Date(s.expiresAt).toISOString(),
      })),
      { onConflict: "token_hash", ignoreDuplicates: true },
    )
    .throwOnError();
}
console.log(`sessions: ${liveSessions.length} live`);

if (settings) {
  await db
    .from("app_settings")
    .upsert({
      id: 1,
      city: settings.city,
      center_lng: settings.center[0],
      center_lat: settings.center[1],
      tz: settings.tz,
      model: settings.model,
      ollama_url: settings.ollamaUrl,
    })
    .throwOnError();
  console.log("settings: 1");
}

if (calendarEntries.length) {
  await db
    .from("calendar_entries")
    .upsert(
      calendarEntries.map((e) => ({
        user_id: e.userId,
        event_id: e.eventId,
        google_event_id: e.googleEventId ?? null,
        added_at: e.addedAt,
      })),
      { onConflict: "user_id,event_id", ignoreDuplicates: true },
    )
    .throwOnError();
}
console.log(`calendar entries: ${calendarEntries.length}`);

const geoRows = Object.entries(geocache).map(([query, v]) => ({
  query,
  lng: v?.lng ?? null,
  lat: v?.lat ?? null,
  name: v?.name ?? "",
}));
if (geoRows.length) {
  await db
    .from("geocode_cache")
    .upsert(geoRows, { onConflict: "query", ignoreDuplicates: true })
    .throwOnError();
}
console.log(`geocode cache: ${geoRows.length}`);

if (ingests.length) {
  await db
    .from("ingests")
    .upsert(
      ingests.map((r) => ({
        id: r.id,
        received_at: r.receivedAt,
        source: r.source,
        kind: r.kind,
        subject: r.subject ?? null,
        extracted: r.extracted,
        added: r.added,
        events: r.events,
      })),
      { onConflict: "id", ignoreDuplicates: true },
    )
    .throwOnError();
}
console.log(`ingests: ${ingests.length}`);

console.log("done — JSON stores migrated to Supabase.");
