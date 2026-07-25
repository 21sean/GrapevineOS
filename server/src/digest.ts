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

function scoreFor(e: CityEvent, taste: Taste): number {
  const ts = terms(e);
  if (ts.some((t) => taste.avoids.includes(t))) return -Infinity;
  if (taste.reactions.get(e.id) === "not_for_me") return -Infinity;
  // No promoted penalty here — weekPicks filters promoted events out entirely.
  let s = e.rating * 2;
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
    tagAffinity: tagAffinity(byId, reactions.map((r) => [r.eventId, r.reaction] as const)),
  };

  const horizon = new Date(c.now.getTime() + 7 * 86_400_000);
  const scored = c.upcoming
    .filter(({ occ }) => new Date(occ.start) <= horizon)
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
