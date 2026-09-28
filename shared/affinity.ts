/**
 * The learned half of the feedback loop: reactions → per-tag weights over the
 * events' own vocabulary. Two "went, great" jazz nights make every jazz
 * event score higher from then on. ONE implementation shared by the web
 * client's ranking (derived.ts) and the server's weekly digest (digest.ts),
 * so the push notification and the on-screen list can't learn differently.
 *
 * Keep this file self-contained (no imports): it is compiled by two
 * TypeScript projects with different module resolutions.
 */

export type ReactionKind = "going" | "went" | "not_for_me";

/** How hard one reaction teaches each of the event's tags. */
export const REACTION_TAG_WEIGHT: Record<ReactionKind, number> = {
  going: 1,
  went: 1.5, // "went, great" is the strongest taste evidence there is
  not_for_me: -1.5,
};

/** An event's teachable vocabulary: its tags (lowercased) plus its category. */
export function affinityTerms(e: { tags: string[]; category: string }): string[] {
  return [...e.tags.map((t) => t.toLowerCase()), e.category];
}

export function tagAffinity(
  events: ReadonlyMap<string, { tags: string[]; category: string }>,
  reactions: Iterable<readonly [string, ReactionKind]>,
): Map<string, number> {
  const affinity = new Map<string, number>();
  for (const [eventId, reaction] of reactions) {
    const e = events.get(eventId);
    if (!e) continue;
    for (const t of affinityTerms(e)) {
      affinity.set(t, (affinity.get(t) ?? 0) + REACTION_TAG_WEIGHT[reaction]);
    }
  }
  return affinity;
}
