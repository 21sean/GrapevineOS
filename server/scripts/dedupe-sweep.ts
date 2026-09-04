/**
 * Dedupe sweep — reports near-duplicates ALREADY stored in the catalog.
 *
 *   npx tsx scripts/dedupe-sweep.ts            # report only
 *   npx tsx scripts/dedupe-sweep.ts --apply    # delete the weaker of each pair
 *
 * The collapse in store.addEvents only guards the write path, so it cannot help
 * rows that landed before it existed, or two spellings that were both new at
 * the same moment. This finds those with the same predicate and, on --apply,
 * deletes the poorer copy.
 *
 * Talks to Postgres directly (like seed-supabase.ts), so it needs SUPABASE_URL
 * and SUPABASE_SECRET_KEY in server/.env but not a running server.
 *
 * Deleting is not always the right call: an event a user saved to their
 * calendar or reacted to carries history that a delete cascades away. Those are
 * reported and skipped, matching what retention.ts already refuses to prune.
 */
import "dotenv/config";
import { db } from "../src/db.js";
import { nearDuplicate, richness } from "../src/dedupe.js";
import { store } from "../src/store.js";

const apply = process.argv.includes("--apply");

const events = await store.events();
console.log(`scanning ${events.length} events\n`);

// Quadratic, but a single-city catalog is hundreds of rows, not millions.
const dropped = new Set<string>();
const pairs: { keep: (typeof events)[number]; drop: (typeof events)[number] }[] = [];
for (let i = 0; i < events.length; i++) {
  if (dropped.has(events[i].id)) continue;
  for (let j = i + 1; j < events.length; j++) {
    if (dropped.has(events[j].id)) continue;
    if (!nearDuplicate(events[i], events[j])) continue;
    const [keep, drop] =
      richness(events[i]) >= richness(events[j]) ? [events[i], events[j]] : [events[j], events[i]];
    dropped.add(drop.id);
    pairs.push({ keep, drop });
  }
}

if (!pairs.length) {
  console.log("no near-duplicates found");
  process.exit(0);
}

// Same protection retention.ts gives: user history is never collateral.
const [cal, reactions] = await Promise.all([
  db.from("calendar_entries").select("event_id").throwOnError(),
  db.from("event_reactions").select("event_id").throwOnError(),
]);
const referenced = new Set([
  ...cal.data.map((r) => r.event_id),
  ...reactions.data.map((r) => r.event_id),
]);

const deletable = pairs.filter((p) => !referenced.has(p.drop.id));
const held = pairs.filter((p) => referenced.has(p.drop.id));

for (const { keep, drop } of deletable) {
  console.log(
    `  keep  ${keep.title}\n  drop  ${drop.title}\n        ${drop.venue} · ${drop.start}\n`,
  );
}
for (const { keep, drop } of held) {
  console.log(
    `  HELD  ${drop.title}\n        duplicate of "${keep.title}" but saved or reacted to — left alone\n`,
  );
}
console.log(
  `${pairs.length} near-duplicate pair${pairs.length === 1 ? "" : "s"}` +
    (held.length ? ` (${held.length} held for user history)` : ""),
);

if (!apply) {
  console.log("\nreport only — re-run with --apply to delete the dropped copies");
  process.exit(0);
}

if (!deletable.length) {
  console.log("nothing deletable");
  process.exit(0);
}
const removed = await store.deleteEvents(deletable.map((p) => p.drop.id));
console.log(`deleted ${removed}/${deletable.length}`);
