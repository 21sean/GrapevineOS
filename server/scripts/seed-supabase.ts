/**
 * One-time data migration: loads the legacy JSON stores (now scripts/seed-data/) into
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
import { normalizeRRule } from "../src/recurrence.js";
import type { CalendarEntry, CityEvent, IngestRecord, Settings, Source } from "../src/types.js";

const DATA_DIR = path.resolve(import.meta.dirname, "seed-data");

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), "utf8")) as T;
  } catch {
    return fallback;
  }
}

// sources.json ships with example.com addresses; INBOX_DOMAIN (the domain the
// email worker really routes) swaps them in at seed time so no operator's
// domain has to live in the repo.
const INBOX_DOMAIN = (process.env.INBOX_DOMAIN ?? "").trim().toLowerCase();
const sources = readJson<Source[]>("sources.json", []).map((s) => ({
  ...s,
  address: INBOX_DOMAIN ? s.address.replace(/@example.com$/i, `@${INBOX_DOMAIN}`) : s.address,
}));
const events = readJson<CityEvent[]>("events.json", []);
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
        address: "",
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
      recurrence: normalizeRRule(e.recurrence),
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
      dedupe_key: eventKey(e, settings?.tz ?? "America/Los_Angeles"),
    })),
    { onConflict: "dedupe_key", ignoreDuplicates: true },
  )
  .throwOnError();
console.log(`events: ${events.length}`);

// users and sessions are Supabase Auth's now: identities live in
// auth.users/auth.identities (see the supabase_auth migration, which carried
// the legacy JSON-era accounts across), so this script no longer seeds them.
// calendar_entries below still requires the referenced user ids to exist.

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
  kind: "geocode",
  query,
  lng: v?.lng ?? null,
  lat: v?.lat ?? null,
  name: v?.name ?? "",
}));
if (geoRows.length) {
  await db
    .from("place_lookups")
    .upsert(geoRows, { onConflict: "kind,query", ignoreDuplicates: true })
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
