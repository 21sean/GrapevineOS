/** Import a reviewed event bundle, retaining ids and user history on refresh.
 * From server/: node --import tsx scripts/refresh-catalog.ts scripts/seed-data/events-2026-q4.json
 * Apply: append --apply. The raw catalog is backed up under ignored data/ first.
 */
import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { db } from "../src/db.js";
import { eventKey, store } from "../src/store.js";
import { nextOccurrence, normalizeRRule } from "../src/recurrence.js";
import { CATEGORIES, RARITIES, type CityEvent } from "../src/types.js";

const eventSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    description: z.string(),
    category: z.enum(CATEGORIES as [CityEvent["category"], ...CityEvent["category"][]]),
    tags: z.array(z.string()),
    venue: z.string().min(1),
    address: z.string(),
    lng: z.number().min(-180).max(180),
    lat: z.number().min(-90).max(90),
    start: z.iso.datetime({ offset: true }),
    end: z.iso.datetime({ offset: true }),
    recurrence: z.string().optional(),
    price: z.string(),
    free: z.boolean(),
    ticketUrl: z.url().optional(),
    sourceUrl: z.url(),
    source: z.string().min(1),
    sourceKind: z.literal("search"),
    rating: z.number().min(1).max(5),
    ratingRationale: z.string(),
    promoted: z.boolean(),
    rarity: z.enum(RARITIES),
  })
  .refine((e) => Date.parse(e.end) >= Date.parse(e.start), "End precedes start");

const file = process.argv.slice(2).find((arg) => !arg.startsWith("--"));
if (!file) throw new Error("Provide a reviewed events JSON file; append --apply to import it.");
const incoming = z
  .array(eventSchema)
  .parse(JSON.parse(await fs.readFile(path.resolve(file), "utf8")));
const { tz } = await store.settings();
const now = new Date();
const upcoming = incoming.filter(
  (e) => Date.parse(nextOccurrence(e, now, tz).end) >= now.getTime(),
);
const keys = upcoming.map((e) => eventKey(e, tz));
if (new Set(keys).size !== keys.length)
  throw new Error("Duplicate event keys in the reviewed bundle");
console.log(
  JSON.stringify({
    reviewed: incoming.length,
    upcoming: upcoming.length,
    skippedPast: incoming.length - upcoming.length,
  }),
);
if (process.argv.includes("--apply")) {
  const rows = [];
  let afterId: string | undefined;
  for (;;) {
    let query = db.from("events").select("*").order("id").limit(500);
    if (afterId) query = query.gt("id", afterId);
    const { data } = await query.throwOnError();
    rows.push(...data);
    if (data.length < 500) break;
    afterId = data.at(-1)!.id;
  }
  const directory = path.resolve("data", "catalog-backups");
  await fs.mkdir(directory, { recursive: true });
  const backup = path.join(directory, `${now.toISOString().replace(/[:.]/g, "-")}.json`);
  await fs.writeFile(backup, JSON.stringify(rows, null, 2) + "\n");
  console.log(`Backed up ${rows.length} events to ${backup}`);

  const added = await store.addEvents(upcoming);
  // The general ingest refresh deliberately preserves some editorial fields.
  // This reviewed bundle also refreshes provenance and canonical recurrence.
  for (const e of upcoming) {
    const { data: existing } = await db
      .from("events")
      .select("id")
      .eq("dedupe_key", eventKey(e, tz))
      .maybeSingle()
      .throwOnError();
    if (!existing) throw new Error(`Event was not imported: ${e.title}`);
    await db
      .from("events")
      .update({ source_url: e.sourceUrl, recurrence: normalizeRRule(e.recurrence) })
      .eq("id", existing.id)
      .throwOnError();
  }
  console.log(JSON.stringify({ added: added.length, refreshed: upcoming.length - added.length }));
}
