/**
 * Near-duplicate collapse for ingested events.
 *
 * `eventKey` (store.ts) keys on the NORMALIZED TITLE plus the local day or the
 * RRULE, so it only catches events two sources spelled identically. In practice
 * they don't: one page calls it "Hillcrest CityFest" and the next calls it
 * "Hillcrest CityFest Summer Block Party", and the catalog grows two rows for
 * one street fair. A 2026-08-02 discovery backfill produced four such pairs in
 * roughly a hundred events, every one of the same shape.
 *
 * Changing `eventKey` itself is not the fix: it backs a unique index and is
 * stored on every row, so a new formula means rewriting the whole table and
 * still cannot know that two spellings mean one event. This collapses instead,
 * just before the write, on a deliberately narrow predicate. All four must
 * hold:
 *
 *   1. the same start INSTANT (not the same local day),
 *   2. the same venue, compared loosely,
 *   3. the same recurrence rule (both one-off, or both the same series),
 *   4. one title's meaningful words are a SUBSET of the other's.
 *
 * Clause 4 is what makes this safe where a venue-and-day key would not be.
 * Two films at 8pm in one multiplex, or two stages at one festival, share no
 * title containment, so they stay separate rows. Only a strict extension of the
 * same name collapses, which is exactly the observed failure.
 */
import { normalizeRRule } from "./recurrence.js";
import type { CityEvent } from "./types.js";

/**
 * Words that carry no identity: dropping them lets "Padres vs. San Francisco
 * Giants" and "San Diego Padres vs. the Giants" compare on the words that
 * actually name the thing. Kept short on purpose - every word removed is a
 * chance for two genuinely different events to look alike.
 */
const TITLE_NOISE = new Set([
  "a",
  "an",
  "the",
  "and",
  "at",
  "in",
  "of",
  "on",
  "for",
  "with",
  "vs",
  "featuring",
  "feat",
  "presents",
  "presented",
  "by",
  "live",
  "tour",
  "show",
  "event",
  "the2026",
  "2026",
]);

/** Identity-bearing lowercase words in a title. */
export function titleTokens(title: string): Set<string> {
  const raw = title.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const meaningful = raw.filter((t) => !TITLE_NOISE.has(t));
  // A title that is nothing but filler ("The Show") still has to compare as
  // something, so fall back to its raw words rather than an empty set, which
  // would make it a subset of everything.
  return new Set(meaningful.length ? meaningful : raw);
}

function isSubset(a: Set<string>, b: Set<string>): boolean {
  if (!a.size) return false; // an empty set is a subset of everything - reject
  for (const t of a) if (!b.has(t)) return false;
  return true;
}

/**
 * Leading and joining words that sources add or drop freely on venue names:
 * "The Rady Shell at Jacobs Park" and "Rady Shell @ Jacobs Park" are one place.
 * Word ORDER is preserved after they're removed, so "Bar at the Park" and
 * "Park Bar" still differ.
 */
const VENUE_NOISE = new Set(["the", "at", "a", "an"]);

/**
 * Spellings of the same word, folded to one form. Ordinals are the ones that
 * actually bite - "Fifth Avenue, Hillcrest" and "5th Avenue, Hillcrest" are one
 * street fair, and without this they read as two venues. Street-type and
 * theater spellings are the same problem in a milder form.
 *
 * Note "st" is deliberately only the street sense; a venue named "St Augustine"
 * simply fails to match "Saint Augustine", which leaves two rows instead of
 * wrongly merging - the safe direction for this predicate to fail.
 */
const VENUE_ALIASES: Record<string, string> = {
  first: "1",
  "1st": "1",
  second: "2",
  "2nd": "2",
  third: "3",
  "3rd": "3",
  fourth: "4",
  "4th": "4",
  fifth: "5",
  "5th": "5",
  sixth: "6",
  "6th": "6",
  seventh: "7",
  "7th": "7",
  eighth: "8",
  "8th": "8",
  ninth: "9",
  "9th": "9",
  tenth: "10",
  "10th": "10",
  street: "st",
  avenue: "ave",
  av: "ave",
  boulevard: "blvd",
  road: "rd",
  drive: "dr",
  parkway: "pkwy",
  square: "sq",
  centre: "ctr",
  center: "ctr",
  theatre: "theater",
  amphitheatre: "amphitheater",
};

function normVenue(v: string | undefined): string {
  const words = (v ?? "").toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const kept = words.filter((w) => !VENUE_NOISE.has(w)).map((w) => VENUE_ALIASES[w] ?? w);
  return (kept.length ? kept : words).join(" ");
}

/** Do these two records describe one event under different names? */
export function nearDuplicate(
  a: Pick<CityEvent, "title" | "start" | "venue" | "recurrence">,
  b: Pick<CityEvent, "title" | "start" | "venue" | "recurrence">,
): boolean {
  // Same instant, compared numerically so two sources that wrote the same
  // moment with different UTC offsets still match.
  const ta = Date.parse(a.start);
  const tb = Date.parse(b.start);
  if (!Number.isFinite(ta) || !Number.isFinite(tb) || ta !== tb) return false;

  const va = normVenue(a.venue);
  const vb = normVenue(b.venue);
  // An unknown venue is not evidence of sameness, so a blank never matches.
  if (!va || va !== vb) return false;

  if ((normalizeRRule(a.recurrence) ?? "") !== (normalizeRRule(b.recurrence) ?? "")) return false;

  const ta_ = titleTokens(a.title);
  const tb_ = titleTokens(b.title);
  return isSubset(ta_, tb_) || isSubset(tb_, ta_);
}

/**
 * How much a record actually tells a reader. Used only to pick which of two
 * duplicates to keep, so the scale is arbitrary - it just has to rank a
 * fleshed-out listing above a stub.
 */
export function richness(e: CityEvent): number {
  return (
    (e.description?.length ?? 0) +
    (e.tags?.length ?? 0) * 20 +
    (e.ticketUrl ? 100 : 0) +
    (e.address ? 40 : 0) +
    (e.ratingRationale ? 30 : 0) +
    (e.imageUrl ? 30 : 0) +
    // Tie-break toward the more specific name ("... Summer Block Party" over
    // the bare "Hillcrest CityFest").
    e.title.length
  );
}

/** Longer of two strings, treating blank as absent. */
function fuller(a: string | undefined, b: string | undefined): string | undefined {
  const x = a?.trim() ? a : undefined;
  const y = b?.trim() ? b : undefined;
  if (!x) return y;
  if (!y) return x;
  return x.length >= y.length ? x : y;
}

/**
 * Fold two duplicates into one: the richer record wins the identity fields,
 * and anything only the other one carried is backfilled rather than lost.
 */
export function mergeEvents(a: CityEvent, b: CityEvent): CityEvent {
  const [keep, drop] = richness(a) >= richness(b) ? [a, b] : [b, a];
  return {
    ...keep,
    description: fuller(keep.description, drop.description) ?? keep.description,
    tags: keep.tags?.length ? keep.tags : (drop.tags ?? []),
    address: keep.address ?? drop.address,
    ticketUrl: keep.ticketUrl ?? drop.ticketUrl,
    ticketProvider: keep.ticketProvider ?? drop.ticketProvider,
    ratingRationale: keep.ratingRationale ?? drop.ratingRationale,
    imageUrl: keep.imageUrl ?? drop.imageUrl,
    // A source that named a price beats one that shrugged.
    price: fuller(keep.price, drop.price) ?? keep.price,
  };
}

/**
 * Collapse near-duplicates inside one batch. Quadratic, which is fine: a batch
 * is one newsletter or one discovery run, tens of events, not thousands.
 */
export function collapseNearDuplicates(events: CityEvent[]): {
  events: CityEvent[];
  collapsed: { kept: string; dropped: string }[];
} {
  const out: CityEvent[] = [];
  const collapsed: { kept: string; dropped: string }[] = [];
  for (const e of events) {
    const i = out.findIndex((k) => nearDuplicate(k, e));
    if (i === -1) {
      out.push(e);
      continue;
    }
    const before = out[i].title;
    out[i] = mergeEvents(out[i], e);
    // Report in terms of what actually survived, which may be either title.
    const dropped = out[i].title === before ? e.title : before;
    collapsed.push({ kept: out[i].title, dropped });
  }
  return { events: out, collapsed };
}

/**
 * Fields worth copying onto an already-stored duplicate. Deliberately excludes
 * title, start, venue and recurrence: the first is load-bearing (dedupe_key is
 * derived from it on write and cannot be patched through updateEvent, so
 * changing it here would silently desync the two), and the rest are equal by
 * the predicate anyway.
 */
export function backfillPatch(existing: CityEvent, incoming: CityEvent): Partial<CityEvent> {
  const patch: Partial<CityEvent> = {};
  const better = fuller(existing.description, incoming.description);
  if (better && better !== existing.description) patch.description = better;
  if (!existing.tags?.length && incoming.tags?.length) patch.tags = incoming.tags;
  if (!existing.address && incoming.address) patch.address = incoming.address;
  if (!existing.ticketUrl && incoming.ticketUrl) patch.ticketUrl = incoming.ticketUrl;
  if (!existing.ticketProvider && incoming.ticketProvider) {
    patch.ticketProvider = incoming.ticketProvider;
  }
  if (!existing.ratingRationale && incoming.ratingRationale) {
    patch.ratingRationale = incoming.ratingRationale;
  }
  const price = fuller(existing.price, incoming.price);
  if (price && price !== existing.price) patch.price = price;
  return patch;
}
