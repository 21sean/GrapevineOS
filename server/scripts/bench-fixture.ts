/**
 * The catalogs behind the TTFT bench. Fixed text, so the prompt is the same on
 * every run and only the clock moves, as it does in production: the fixture week
 * is shifted to start now, because the app drops events that have already ended.
 */
import { FIXTURE_EVENTS, FIXTURE_NOW } from "../src/evals/fixtures.js";
import type { CityEvent } from "../src/types.js";

/**
 * Free text in a real listing runs longer than the fixture's one-liners: the
 * stored catalog's median event is about 800 characters of JSON. This brings a
 * cloned event to about that size.
 */
const LISTING_TEXT =
  "A neighborhood favorite that fills up early, with food vendors along the block, shaded seating, and street parking a short walk away. Doors open thirty minutes before the listed start, kids are welcome until eight, and rideshare drop-off is on the side street. Check the organizer's page on the day for weather changes.";

function shifted(e: CityEvent, offsetMs: number): CityEvent {
  const move = (iso: string) => new Date(Date.parse(iso) + offsetMs).toISOString();
  return { ...e, start: move(e.start), end: move(e.end) };
}

/** Fifteen fixture events, or as many clones of them as asked for, starting from now. */
export function benchCatalog(size: number, now = new Date()): CityEvent[] {
  const offset = now.getTime() - FIXTURE_NOW.getTime();
  // The fixture week ends in five days; clones spread over the following weeks.
  const week = 7 * 24 * 3_600_000;
  const out: CityEvent[] = [];
  for (let i = 0; out.length < size; i++) {
    const copy = Math.floor(i / FIXTURE_EVENTS.length);
    const e = FIXTURE_EVENTS[i % FIXTURE_EVENTS.length];
    if (copy === 0 && size <= FIXTURE_EVENTS.length) {
      out.push(shifted(e, offset));
      continue;
    }
    out.push({
      ...shifted(e, offset + copy * week),
      id: copy === 0 ? e.id : `${e.id}-w${copy}`,
      title: copy === 0 ? e.title : `${e.title} (week ${copy + 1})`,
      description: `${e.description} ${LISTING_TEXT}`.trim(),
    });
  }
  return out;
}

/**
 * The same catalog with the soonest listing edited, which is what a new or
 * changed event does: everything in the prompt after it stops matching the cache.
 */
export function withNonce(catalog: CityEvent[], n: number): CityEvent[] {
  const soonest = catalog.reduce((a, b) => (Date.parse(a.start) <= Date.parse(b.start) ? a : b));
  return catalog.map((e) =>
    e.id === soonest.id ? { ...e, title: `${e.title} (update ${n})` } : e,
  );
}
