/**
 * "Your week in San Diego" — the top upcoming events for one user, scored the
 * same way the client ranks its list (buzz backbone, rarity and free bumps,
 * interests tilt) plus the reaction feedback loop: tags from events the user
 * marked "going"/"went — great" pull similar events up, "not for me" pushes
 * them down and drops the event itself.
 *
 * The web app computes its own digest client-side from the same signals; this
 * server copy exists so the Sunday push can be written without a client.
 */
import { affinityTerms, tagAffinity } from "../../shared/affinity.js";
import { buildCtx, dayInTz, fmtRange, type AgentCtx } from "./agent/context.js";
import { store } from "./store.js";
import type { CityEvent, Reaction, User } from "./types.js";

interface Taste {
  loves: string[];
  avoids: string[];
  reactions: Map<string, Reaction>;
  tagAffinity: Map<string, number>;
}

const terms = affinityTerms;

/** Mirror of web scoreEvent's AVOID_PENALTY — avoided topics sink an event
 * hard but don't erase it, so the weekly picks stay in sync with the client
 * list and a single avoided tag can't wall off an otherwise-strong event. */
const AVOID_PENALTY = 12;

/** Prefs arrive as untyped JSON — keep only the strings. */
export function stringList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/** Muted venues/sources from account prefs, lowercased for matching. */
export function mutedSets(user: User): { venues: Set<string>; sources: Set<string> } {
  const lc = (s: string) => s.trim().toLowerCase();
  return {
    venues: new Set(stringList(user.prefs?.mutedVenues).map(lc)),
    sources: new Set(stringList(user.prefs?.mutedSources).map(lc)),
  };
}

export function isMutedFor(
  e: Pick<CityEvent, "venue" | "source">,
  muted: { venues: Set<string>; sources: Set<string> },
): boolean {
  return (
    muted.venues.has(e.venue.trim().toLowerCase()) ||
    muted.sources.has(e.source.trim().toLowerCase())
  );
}

function scoreFor(e: CityEvent, taste: Taste): number {
  const ts = terms(e);
  // "not for me" is an explicit per-event veto — keep it a hard drop. Avoids
  // are passive taste: sink them, don't erase (matches the client's scoreEvent).
  if (taste.reactions.get(e.id) === "not_for_me") return -Infinity;
  // No promoted penalty here — weekPicks filters promoted events out entirely.
  let s = e.rating * 2;
  if (ts.some((t) => taste.avoids.includes(t))) s -= AVOID_PENALTY;
  if (e.rarity === "rare") s += 1.5;
  if (e.rarity === "notable") s += 0.5;
  const loved = ts.filter((t) => taste.loves.includes(t)).length;
  s += Math.min(loved * 2, 4);
  if (e.free) s += 0.3;
  // learned taste: reacted-event tags pull neighbors up/down, capped like loves
  const learned = ts.reduce((sum, t) => sum + (taste.tagAffinity.get(t) ?? 0), 0);
  s += Math.max(-3, Math.min(3, learned));
  if (taste.reactions.get(e.id) === "going") s += 3;
  return s;
}

export interface WeekPick {
  id: string;
  title: string;
  venue: string;
  when: string;
  day: string; // YYYY-MM-DD city-local
  free: boolean;
  price: string;
  rating: number;
}

/** Top `limit` events in the next 7 days for this user, best first. */
export async function weekPicks(
  user: User,
  limit = 6,
  ctx?: AgentCtx,
): Promise<{ city: string; picks: WeekPick[] }> {
  const c = ctx ?? (await buildCtx());
  const { tz, city } = c.settings;
  const interests = (user.prefs?.interests ?? {}) as { loves?: string[]; avoids?: string[] };
  const reactions = await store.userReactions(user.id).catch(() => []);
  const byId = new Map(c.upcoming.map(({ e }) => [e.id, e]));
  const taste: Taste = {
    loves: interests.loves ?? [],
    avoids: interests.avoids ?? [],
    reactions: new Map(reactions.map((r) => [r.eventId, r.reaction])),
    tagAffinity: tagAffinity(
      byId,
      reactions.map((r) => [r.eventId, r.reaction] as const),
    ),
  };

  const muted = mutedSets(user);
  const horizon = new Date(c.now.getTime() + 7 * 86_400_000);
  const scored = c.upcoming
    .filter(({ occ }) => new Date(occ.start) <= horizon)
    .filter(({ e }) => !isMutedFor(e, muted))
    .map((u) => ({ ...u, score: scoreFor(u.e, taste) }))
    .filter((u) => u.score > -Infinity && !u.e.promoted)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return {
    city,
    picks: scored.map(({ e, occ }) => ({
      id: e.id,
      title: e.title,
      venue: e.venue,
      when: fmtRange(occ, tz),
      day: dayInTz(occ.start, tz),
      free: e.free,
      price: e.price,
      rating: e.rating,
    })),
  };
}
