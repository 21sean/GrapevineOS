/**
 * Personalization and grounding, asked on behalf of four example users.
 *
 * These are the promises the app makes to a person rather than to a function:
 * that a free-only search is free, that a 3 km radius means 3 km, that paid
 * placement stays out of the way, and that the concierge cannot name an event
 * that does not exist. Nothing here throws when it breaks, which is exactly
 * why it is worth asserting.
 *
 * Every case runs against the frozen catalog in fixtures.ts at a frozen
 * instant, through the same executors the agent's tools and the external API
 * call. No network, no database, no model.
 */
import { tagAffinity } from "../../../../shared/affinity.js";
import {
  buildDigest,
  DIGEST_MAX_CHARS,
  DIGEST_MAX_EVENTS,
  buildSystemPrompt,
  haversineKm,
  searchEvents,
  vetEventIds,
  type SearchParams,
} from "../../agent/context.js";
import type { CityEvent } from "../../types.js";
import { expect, expectEq, expectIds, show, type EvalSuite } from "../harness.js";
import { FIXTURE_EVENTS, FIXTURE_NOW, fixtureCtx, PLACES } from "../fixtures.js";
import { PERSONAS } from "../personas.js";

const ctx = fixtureCtx();

/** Ids a search returns, in the order it returned them. */
async function found(params: SearchParams, c = ctx): Promise<string[]> {
  const res = await searchEvents(params, c);
  return (res.events ?? []).map((e) => e.id);
}

const persona = (id: string) => {
  const p = PERSONAS.find((x) => x.id === id);
  if (!p) throw new Error(`unknown persona ${id}`);
  return p;
};

const nora = persona("nora-new-in-town");
const marcus = persona("marcus-weekend-dad");
const priya = persona("priya-car-free");
const dana = persona("dana-power-user");

/** A catalog big enough that the caps actually bind. */
function syntheticCatalog(n: number): CityEvent[] {
  return Array.from({ length: n }, (_, i) => ({
    ...FIXTURE_EVENTS[0],
    id: `synthetic-${i}`,
    title: `Synthetic Event Number ${i} With A Fairly Long Title For Padding`,
    start: new Date(Date.parse("2026-08-06T19:00:00-07:00") + i * 3_600_000).toISOString(),
    end: new Date(Date.parse("2026-08-06T21:00:00-07:00") + i * 3_600_000).toISOString(),
  }));
}

export const personaSuite: EvalSuite = {
  id: "personas",
  title: "Personalization and grounding",
  what: "What four example users are promised: honest filters, real distances, no invented events.",
  kind: "offline",
  threshold: 1,
  cases: () => [
    // ---- Nora: new in town, wants music, not a club night --------------
    {
      id: "nora-music-tonight-excludes-paid-placement",
      name: `${nora.name}: music tonight, with paid placement kept out`,
      note: "The promoted listing is the same night and the same category, so only the promoted flag separates it. If exclusion ever inverts, the worst event in the catalog leads the answer.",
      run: async () => {
        const ids = await found({
          categories: ["music"],
          date_from: "2026-08-05",
          date_to: "2026-08-05",
        });
        expectIds(ids, ["shoreline-jazz", "casbah-moonchild"], "music tonight");
        return "the free bayside set and the Casbah show; the bottle-service night stays out";
      },
    },
    {
      id: "nora-promoted-on-request",
      name: `${nora.name}: promoted events are hidden, not deleted`,
      note: "Suppression that cannot be undone is censorship, not ranking. Asking for it explicitly must return it.",
      run: async () => {
        const ids = await found({
          categories: ["music"],
          date_from: "2026-08-05",
          date_to: "2026-08-05",
          exclude_promoted: false,
        });
        expect(
          ids.includes("gaslamp-bottle-service"),
          "asked for promoted events and still did not get them",
        );
        return "3 events once promoted listings are asked for by name";
      },
    },
    {
      id: "nora-promoted-only-explains-itself",
      name: `${nora.name}: an all-promoted result says why it is empty`,
      note: "Without the hint the model burns tool rounds guessing why a real match came back empty, then tells the user nothing exists.",
      run: async () => {
        const res = await searchEvents({ tags: ["edm"] }, ctx);
        expectEq(res.count, 0, "visible matches");
        expect(
          res.hint?.includes("exclude_promoted"),
          `hint did not name the fix: ${show(res.hint)}`,
        );
        return "count 0 with a hint naming exclude_promoted";
      },
    },
    {
      id: "nora-tag-and-text-search",
      name: `${nora.name}: tag and free-text search are both exact`,
      note: "Free text is AND across words. OR would make every query return the whole catalog.",
      run: async () => {
        expectIds(await found({ tags: ["jazz"] }), ["shoreline-jazz"], "tag search");
        expectIds(
          await found({ query: "jazz shell" }),
          ["shoreline-jazz"],
          "two words that both match one event",
        );
        expectEq(
          (await searchEvents({ query: "jazz casbah" }, ctx)).count,
          0,
          "two words that match different events",
        );
        return "tag exact, text AND across words";
      },
    },

    // ---- Marcus: free, family, this weekend ---------------------------
    {
      id: "marcus-free-only-is-free",
      name: `${marcus.name}: free-only returns only free events`,
      note: "He plans a Saturday around this. One ticketed event slipping through is a $45 surprise at the gate.",
      run: async () => {
        const ids = await found({
          free_only: true,
          date_from: "2026-08-08",
          date_to: "2026-08-09",
          limit: 20,
        });
        const paid = ids.filter((id) => {
          const e = FIXTURE_EVENTS.find((x) => x.id === id);
          return e && !e.free;
        });
        expectEq(paid, [], "ticketed events in a free-only result");
        expect(!ids.includes("beer-garden-fest"), "the $45 beer festival came back as free");
        expect(ids.length >= 5, `only ${ids.length} free weekend events found`);
        return `${ids.length} free events across Saturday and Sunday, none ticketed`;
      },
    },
    {
      id: "marcus-recurring-resolves-to-the-day-asked",
      name: `${marcus.name}: the weekly Mercato lands on the Saturday he asked about`,
      note: "The stored anchor is one date; the answer has to be the occurrence inside his window, with the weekly label kept.",
      run: async () => {
        const res = await searchEvents(
          { tags: ["farmers market"], date_from: "2026-08-08", date_to: "2026-08-08" },
          ctx,
        );
        const mercato = res.events?.find((e) => e.id === "little-italy-mercato");
        expect(mercato, "the Saturday Mercato was not in a Saturday search");
        expect(mercato.when.startsWith("Sat, Aug 8"), `resolved to ${show(mercato.when)}`);
        expectEq(mercato.recurs, "Weekly on Sat", "recurrence label");
        return `${mercato.when} (${mercato.recurs})`;
      },
    },
    {
      id: "marcus-nothing-in-the-past",
      name: `${marcus.name}: nothing that already happened comes back`,
      note: "The Tuesday taco crawl finished before the clock. An expired event on a weekend plan sends someone to a closed street.",
      run: async () => {
        expect(
          !ctx.byId.has("barrio-taco-crawl"),
          "a finished event is still in the agent snapshot",
        );
        const everything = await found({ limit: 20, exclude_promoted: false });
        expect(
          !everything.includes("barrio-taco-crawl"),
          "a finished event came back in an unfiltered search",
        );
        return "the finished event is absent from both the snapshot and search";
      },
    },

    // ---- Priya: no car ------------------------------------------------
    {
      id: "priya-radius-is-honest",
      name: `${priya.name}: a 3 km radius really is 3 km`,
      note: "She cannot get to La Jolla or Encinitas at all. An off-by-a-factor here is not a worse ranking, it is a wasted evening.",
      run: async () => {
        const near = fixtureCtx({ userPos: priya.home });
        const ids = await found(
          { near: `${priya.home[0]},${priya.home[1]}`, max_km: 3, limit: 20 },
          near,
        );
        const over = ids
          .map((id) => FIXTURE_EVENTS.find((e) => e.id === id)!)
          .filter((e) => haversineKm(priya.home, [e.lng, e.lat]) > 3);
        expectEq(
          over.map((e) => e.id),
          [],
          "events returned from beyond the radius",
        );
        expect(
          !ids.includes("encinitas-beach-yoga"),
          "Encinitas (35 km) came back inside a 3 km radius",
        );
        expect(!ids.includes("tide-pool-walk"), "La Jolla (17 km) came back inside a 3 km radius");
        expect(ids.length >= 4, `only ${ids.length} events within 3 km`);
        return `${ids.length} events, all within 3 km of ${priya.homeLabel}`;
      },
    },
    {
      id: "priya-distance-sort-orders-by-distance",
      name: `${priya.name}: sorting by distance actually orders by distance`,
      note: "Asserting the ordering rather than a specific first result, because two venues can sit at the same point.",
      run: async () => {
        const ids = await found({
          near: `${priya.home[0]},${priya.home[1]}`,
          sort: "distance",
          limit: 8,
        });
        const km = ids.map((id) => {
          const e = FIXTURE_EVENTS.find((x) => x.id === id)!;
          return haversineKm(priya.home, [e.lng, e.lat]);
        });
        for (let i = 1; i < km.length; i++) {
          expect(
            km[i] >= km[i - 1] - 1e-9,
            `result ${i + 1} (${km[i].toFixed(2)} km) is closer than result ${i} (${km[i - 1].toFixed(2)} km)`,
          );
        }
        return `${km.length} results, ${km[0].toFixed(1)}–${km[km.length - 1].toFixed(1)} km, non-decreasing`;
      },
    },
    {
      id: "priya-unknown-origin-degrades-loudly",
      name: `${priya.name}: an unknown location drops the filter and says so`,
      note: "Silently returning the whole city as if it were nearby is the failure that costs trust. Returning nothing is the failure that costs the session.",
      run: async () => {
        const res = await searchEvents({ near: "user", max_km: 3 }, ctx);
        expect(res.count > 0, "an unknown origin returned nothing at all");
        expect(
          res.note?.includes("skipped"),
          `no note explaining the dropped filter: ${show(res.note)}`,
        );
        return `${res.count} results with the note ${show(res.note)}`;
      },
    },

    // ---- Dana: the taste profile most likely to drift ------------------
    {
      id: "dana-affinity-learns-the-right-tags",
      name: `${dana.name}: two nights out teach jazz and outdoors`,
      note: "The same weights feed the on-screen ranking and the Sunday digest push, so drift here reaches two surfaces at once.",
      run: () => {
        const catalog = new Map(FIXTURE_EVENTS.map((e) => [e.id, e]));
        const affinity = tagAffinity(catalog, Object.entries(dana.reactions));
        expect((affinity.get("jazz") ?? 0) > 0, `jazz weight is ${affinity.get("jazz") ?? 0}`);
        expect(
          (affinity.get("outdoors") ?? 0) > 0,
          `outdoors weight is ${affinity.get("outdoors") ?? 0}`,
        );
        expect(
          (affinity.get("live music") ?? 0) > (affinity.get("jazz") ?? 0),
          "the tag she reacted to twice does not outweigh the tag she reacted to once",
        );
        return `jazz ${affinity.get("jazz")}, outdoors ${affinity.get("outdoors")}, live music ${affinity.get("live music")}`;
      },
    },
    {
      id: "dana-rejection-stays-negative",
      name: `${dana.name}: a rejection never flips into a recommendation`,
      note: 'She marked the bottle-service night "not for me". Its tags must stay below zero however many other events she likes.',
      run: () => {
        const catalog = new Map(FIXTURE_EVENTS.map((e) => [e.id, e]));
        const affinity = tagAffinity(catalog, Object.entries(dana.reactions));
        for (const tag of ["edm", "dancing", "nightlife"]) {
          expect(
            (affinity.get(tag) ?? 0) < 0,
            `${tag} weight is ${affinity.get(tag) ?? 0}, not negative`,
          );
        }
        return `edm ${affinity.get("edm")}, dancing ${affinity.get("dancing")}, nightlife ${affinity.get("nightlife")}`;
      },
    },
    {
      id: "dana-deleted-event-cannot-corrupt-taste",
      name: `${dana.name}: a reaction to a since-deleted event is ignored`,
      note: "Retention prunes finished events nightly while reactions live on, so this pairing happens on its own within a week.",
      run: () => {
        const catalog = new Map(FIXTURE_EVENTS.map((e) => [e.id, e]));
        const withGhost = { ...dana.reactions, "event-that-was-pruned": "going" as const };
        const before = tagAffinity(catalog, Object.entries(dana.reactions));
        const after = tagAffinity(catalog, Object.entries(withGhost));
        expectEq(
          Object.fromEntries(after),
          Object.fromEntries(before),
          "affinity with a ghost reaction",
        );
        return "identical weights, no entry created for the missing event";
      },
    },

    // ---- Grounding: what the concierge is allowed to say ---------------
    {
      id: "grounding-ids-are-vetted",
      name: "Grounding: invented and expired event ids are refused",
      note: "Every id the model emits is checked against the snapshot before it can pin a map or save a calendar entry. This is the check that turns a hallucination into a no-op instead of a wrong pin.",
      run: () => {
        const vetted = vetEventIds(
          ["shoreline-jazz", "totally-made-up", "barrio-taco-crawl", "shoreline-jazz"],
          ctx,
        );
        expectIds(vetted, ["shoreline-jazz"], "vetted ids");
        expectEq(vetEventIds("shoreline-jazz", ctx), [], "a non-array argument");
        return "real id kept, invented and expired ids dropped, duplicates collapsed";
      },
    },
    {
      id: "grounding-limits-are-clamped",
      name: "Grounding: a tool argument cannot ask for the whole catalog",
      note: "The model chooses these numbers. An unclamped limit is how one tool call fills the context window and the answer stops mentioning the events it found.",
      run: async () => {
        const big = fixtureCtx({ events: syntheticCatalog(30) });
        expectEq((await searchEvents({ limit: 999 }, big)).events?.length, 20, "limit 999");
        expectEq((await searchEvents({ limit: 0 }, big)).events?.length, 1, "limit 0");
        expectEq((await searchEvents({ limit: -5 }, big)).events?.length, 1, "negative limit");
        return "clamped to 1–20 whatever the model asks for";
      },
    },
    {
      id: "grounding-digest-is-bounded",
      name: "Grounding: the digest stays inside its budget on a full catalog",
      note: "The digest is pasted into every system prompt. On a busy week an unbounded one silently truncates mid-line inside the model, and the events at the end of the week stop existing.",
      run: () => {
        const big = fixtureCtx({ events: syntheticCatalog(400) });
        expectEq(big.upcoming.length, 400, "events in the snapshot");
        const digest = buildDigest(big);
        const lines = digest.split("\n").length;
        expect(
          digest.length <= DIGEST_MAX_CHARS,
          `digest is ${digest.length} chars, over the ${DIGEST_MAX_CHARS} budget`,
        );
        expect(
          lines <= DIGEST_MAX_EVENTS,
          `digest has ${lines} lines, over the ${DIGEST_MAX_EVENTS} budget`,
        );
        expect(
          !digest.endsWith("\n") && digest.split("\n").every((l) => l.includes(" | ")),
          "the digest was cut mid-line",
        );
        return `400 events in, ${lines} whole lines and ${digest.length} chars out`;
      },
    },
    {
      id: "grounding-prompt-carries-the-identity-clause",
      name: "Grounding: the system prompt still carries its identity clause",
      note: "The prompt is the first half of the defence the persona rail backs up. A refactor that drops this clause shows up as a model-identity leak in production, not as a failing build.",
      run: () => {
        const prompt = buildSystemPrompt(
          ctx,
          { interests: { loves: nora.loves, avoids: nora.avoids } },
          true,
        );
        expect(prompt.includes("you are Grapevine, nothing else"), "the identity clause is gone");
        expect(prompt.includes("never invent"), "the do-not-invent clause is gone");
        expect(prompt.includes(nora.avoids[0]), "the user's avoids never reached the prompt");
        expect(
          prompt.includes(String(FIXTURE_NOW.getFullYear())),
          "the authoritative clock never reached the prompt",
        );
        return "identity, do-not-invent, interests, and clock all present";
      },
    },
    {
      id: "grounding-fixture-covers-the-map",
      name: "Grounding: the fixture catalog still exercises every branch",
      note: "An eval suite decays when its fixtures do. If the catalog loses its promoted, recurring, free, or expired event, several cases above start passing for the wrong reason.",
      run: () => {
        const has = (label: string, pred: (e: CityEvent) => boolean) =>
          expect(FIXTURE_EVENTS.some(pred), `the fixture catalog no longer contains ${label}`);
        has("a promoted event", (e) => e.promoted);
        has("a recurring event", (e) => !!e.recurrence);
        has("a free event", (e) => e.free);
        has("a ticketed event", (e) => !e.free);
        has("an event that has already ended", (e) => Date.parse(e.end) < FIXTURE_NOW.getTime());
        has(
          "an event more than 20 km out",
          (e) => haversineKm(PLACES.gaslamp, [e.lng, e.lat]) > 20,
        );
        has(
          "an event live at the frozen clock",
          (e) =>
            Date.parse(e.start) <= FIXTURE_NOW.getTime() &&
            Date.parse(e.end) >= FIXTURE_NOW.getTime(),
        );
        return `${FIXTURE_EVENTS.length} events covering every branch the cases above rely on`;
      },
    },
  ],
};
