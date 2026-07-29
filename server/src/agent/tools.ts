/**
 * The agent's toolbox as LangChain structured tools (zod-validated, bound to
 * the model via bindTools). Built per request so each tool closes over the
 * same immutable event snapshot the system prompt was written from.
 *
 * Two kinds:
 *  - data tools (search_events / get_event / get_eta) run here and return
 *    JSON the model reads;
 *  - UI tools (show_on_map / propose_calendar / update_interests) emit an
 *    "action" frame to the browser via the LangGraph custom-stream writer and
 *    return a receipt telling the model the user still has to confirm.
 */
import { tool } from "@langchain/core/tools";
import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import { z } from "zod";
import { saveEventForUser } from "../calendar.js";
import { runDiscovery, validQuery } from "../discovery.js";
import { CATEGORIES, type Category } from "../types.js";
import {
  INTEREST_TOPICS,
  RARITIES,
  getEta,
  getEvent,
  searchEvents,
  setEventRarity,
  vetEventIds,
  vetTopics,
  type AgentCtx,
  type ChatContext,
} from "./context.js";
import { scanText } from "./guardrails.js";
import { readPage, webSearch } from "./websearch.js";

/** Push a frame onto the "custom" stream (no-op outside a streamed run). */
function emit(config: LangGraphRunnableConfig | undefined, frame: Record<string, unknown>) {
  config?.writer?.(frame);
}

const lngLat = z
  .array(z.number())
  .length(2)
  .describe("[lng, lat]");

export function makeTools(ctx: AgentCtx, chat: ChatContext) {
  const searchTool = tool(
    async (input) => JSON.stringify(await searchEvents(input, ctx)),
    {
      name: "search_events",
      description:
        "Search the live event set. All filters optional; omit for the top upcoming events. Dates are city-local YYYY-MM-DD applied to each event's next occurrence.",
      schema: z.object({
        query: z
          .string()
          .describe("Free text matched against title, description, venue, and tags")
          .optional(),
        categories: z.array(z.enum(CATEGORIES as [Category, ...Category[]])).optional(),
        tags: z.array(z.string()).optional(),
        date_from: z.string().describe("YYYY-MM-DD inclusive").optional(),
        date_to: z.string().describe("YYYY-MM-DD inclusive").optional(),
        free_only: z.boolean().optional(),
        min_rating: z.number().describe("1-5 local-buzz floor").optional(),
        exclude_promoted: z
          .boolean()
          .describe("Default true — drop paid placements")
          .optional(),
        near: z
          .string()
          .describe('A venue/neighborhood name, or "user" for the user\'s location')
          .optional(),
        max_km: z.number().describe("Only with near — straight-line radius").optional(),
        sort: z.enum(["time", "buzz", "distance"]).optional(),
        limit: z.number().describe("Max results, up to 20 (default 8)").optional(),
      }),
    },
  );

  const getEventTool = tool(
    async (input) => JSON.stringify(getEvent(input.id, ctx)),
    {
      name: "get_event",
      description:
        "Full details for one event: description, address, ticket link, buzz rationale.",
      schema: z.object({ id: z.string() }),
    },
  );

  const etaTool = tool(
    async (input) => JSON.stringify(await getEta(input, ctx)),
    {
      name: "get_eta",
      description:
        "Traffic-aware driving ETA. Give to_event_id (preferred) or to coordinates; from defaults to the user's location when known, else the city center.",
      schema: z.object({
        to_event_id: z.string().optional(),
        to: lngLat.optional(),
        from: lngLat.optional(),
      }),
    },
  );

  const webSearchTool = tool(
    async (input, config) => {
      const result = await webSearch(input.query, { limit: input.limit, signal: config?.signal });
      // Content rail: web text is untrusted — drop hits that read like
      // indirect prompt injection before they enter the model's context.
      if ("results" in result) {
        const verdicts = await Promise.all(
          result.results.map((hit) => scanText(`${hit.title}\n${hit.snippet}`)),
        );
        const results = result.results.filter((_, i) => !verdicts[i].malicious);
        const dropped = result.results.length - results.length;
        return JSON.stringify({
          ...result,
          count: results.length,
          results,
          ...(dropped && {
            note: `${dropped} result(s) withheld by guardrails (suspected prompt injection)`,
          }),
        });
      }
      return JSON.stringify(result);
    },
    {
      name: "search_web",
      description:
        "Search the live web (keyless local metasearch — SearXNG or DuckDuckGo). Use for anything the event catalog can't answer: artist background, venue details or hours, weather, news, things the digest doesn't list. Returns titles, urls, snippets.",
      schema: z.object({
        query: z.string().describe("A focused search query"),
        limit: z.number().describe("Max results, up to 8 (default 5)").optional(),
      }),
    },
  );

  const readPageTool = tool(
    async (input, config) => {
      const result = await readPage(input.url, { signal: config?.signal });
      if ("text" in result) {
        const verdict = await scanText(result.text);
        if (verdict.malicious)
          return JSON.stringify({
            error: `page withheld by guardrails — its content looks like a prompt-injection attempt (score ${verdict.score.toFixed(2)}). Do not retry this url.`,
          });
      }
      return JSON.stringify(result);
    },
    {
      name: "read_page",
      description:
        "Fetch one web page and return its readable text (reader-mode extraction, truncated). Use on the most promising search_web result when snippets aren't enough.",
      schema: z.object({
        url: z.string().describe("A full http(s) url, usually from search_web results"),
      }),
    },
  );

  const discoverTool = tool(
    async (input, config) => {
      const query = validQuery(input.query);
      if (!query) return JSON.stringify({ error: "query must be 3-200 chars" });
      const commit = input.commit === true;
      // Chat keeps latency tolerable by reading fewer pages than a scheduled
      // run; the verification gate (source-quote check + LLM cross-read +
      // catalog dedupe) is identical.
      const run = await runDiscovery({ query, commit, maxPages: 3 });
      if (commit && run.added > 0) {
        emit(config, {
          type: "action",
          action: { kind: "eventsRefresh", count: run.added },
        });
      }
      return JSON.stringify({
        query: run.query,
        pages_read: run.pagesRead.length,
        extracted: run.extracted,
        verified: run.verified.slice(0, 12).map((c) => ({
          title: c.event.title,
          start: c.event.start,
          venue: c.event.venue,
          source_url: c.sourceUrl,
          confidence: c.confidence,
        })),
        rejected: run.rejected.length,
        added: run.added,
        committed: commit,
        ...(run.error && { error: run.error }),
        note: commit
          ? run.added
            ? `${run.added} new event(s) are in the catalog now — already visible in the user's list and map.`
            : "nothing new to add — every verified event was already in the catalog"
          : "dry run, nothing written. Re-run with commit:true to add the verified events.",
      });
    },
    {
      name: "discover_events",
      description:
        "Web-search for local events, verify each candidate against its source page, and (with " +
        "commit:true) add the verified ones to the live event catalog — the user's list and map. " +
        "Use when the digest can't answer and the user wants real events, or when the user asks to " +
        "add events you found with search_web (re-discovering the same topic finds and verifies " +
        "them properly). Slow — several pages are read and cross-checked. Default is a dry-run " +
        "preview; pass commit:true only when the user asked for the events to be added.",
      schema: z.object({
        query: z
          .string()
          .describe('What to look for, e.g. "live jazz San Diego this weekend"'),
        commit: z
          .boolean()
          .describe("false (default) previews; true writes verified events to the catalog")
          .optional(),
      }),
    },
  );

  const showOnMapTool = tool(
    async (input, config) => {
      const ids = vetEventIds(input.event_ids, ctx);
      if (!ids.length)
        return JSON.stringify({
          error: "no valid event ids — use ids from the digest or search results",
        });
      emit(config, { type: "action", action: { kind: "highlight", eventIds: ids, fit: true } });
      return `Highlighted ${ids.length} event${ids.length === 1 ? "" : "s"} on the user's map.`;
    },
    {
      name: "show_on_map",
      description:
        "Highlight events on the user's map and fly the camera to them. Call after choosing which events to recommend.",
      schema: z.object({ event_ids: z.array(z.string()) }),
    },
  );

  const proposeCalendarTool = tool(
    async (input, config) => {
      const ids = vetEventIds(input.event_ids, ctx);
      if (!ids.length)
        return JSON.stringify({
          error: "no valid event ids — use ids from the digest or search results",
        });
      emit(config, {
        type: "action",
        action: {
          kind: "proposeCalendar",
          eventIds: ids,
          ...(input.note ? { note: input.note.slice(0, 120) } : {}),
        },
      });
      return (
        `Save card shown for ${ids.length} event${ids.length === 1 ? "" : "s"}. ` +
        (chat.signedIn
          ? "The user will confirm — do not claim anything is saved."
          : "The user is signed out and will be asked to sign in first.")
      );
    },
    {
      name: "propose_calendar",
      description:
        "Show the user a save-to-calendar card for the given events. The user confirms — never claim anything is saved.",
      schema: z.object({
        event_ids: z.array(z.string()),
        note: z.string().describe('Short label for the plan, e.g. "Saturday night"').optional(),
      }),
    },
  );

  const setFiltersTool = tool(
    async (input, config) => {
      // Only forward the knobs the model actually set — the client merges the
      // patch into its current filters (or resets first when asked).
      const patch: Record<string, unknown> = {
        ...(input.categories !== undefined && { categories: input.categories }),
        ...(input.live_only !== undefined && { liveOnly: input.live_only }),
        ...(input.rare_only !== undefined && { rareOnly: input.rare_only }),
        ...(input.free_only !== undefined && { freeOnly: input.free_only }),
        ...(input.farmers !== undefined && { farmers: input.farmers }),
        ...(input.hide_promoted !== undefined && { hidePromoted: input.hide_promoted }),
        ...(input.min_buzz !== undefined && {
          minRating: Math.min(5, Math.max(0, input.min_buzz)),
        }),
        ...(input.date_from !== undefined && { dateFrom: input.date_from }),
        ...(input.date_to !== undefined && { dateTo: input.date_to }),
      };
      if (!input.reset && Object.keys(patch).length === 0) {
        return JSON.stringify({ error: "set at least one filter (or reset:true)" });
      }
      emit(config, {
        type: "action",
        action: {
          kind: "setFilters",
          reset: Boolean(input.reset),
          patch,
          ...(input.note ? { note: String(input.note).slice(0, 120) } : {}),
        },
      });
      return JSON.stringify({
        ok: true,
        applied: { reset: Boolean(input.reset), ...patch },
        note: "The user's map and list now show only matching events. They see a notice and can undo.",
      });
    },
    {
      name: "set_filters",
      description:
        'Change the filters on the user\'s live map ("free stuff this weekend", "only music", "hide farmers markets"). ' +
        "Only pass the knobs the user asked about; the rest keep their values. reset:true clears everything back to defaults first.",
      schema: z.object({
        reset: z.boolean().describe("Clear all filters to defaults before applying").optional(),
        categories: z
          .array(z.enum(CATEGORIES as [Category, ...Category[]]))
          .describe("Show only these categories; [] shows all")
          .optional(),
        live_only: z.boolean().optional(),
        rare_only: z.boolean().describe("Only rare one-offs (parades, festivals)").optional(),
        free_only: z.boolean().optional(),
        farmers: z.enum(["any", "only", "hide"]).describe("Farmers-market volume control").optional(),
        hide_promoted: z.boolean().optional(),
        min_buzz: z.number().describe("1-5 local-buzz floor; 0 clears it").optional(),
        date_from: z
          .string()
          .nullable()
          .describe("YYYY-MM-DD inclusive — only events occurring on/after; null clears")
          .optional(),
        date_to: z
          .string()
          .nullable()
          .describe("YYYY-MM-DD inclusive — only events occurring on/before; null clears")
          .optional(),
        note: z.string().describe('Short label shown to the user, e.g. "Free this weekend"').optional(),
      }),
    },
  );

  const saveCalendarTool = tool(
    async (input, config) => {
      const user = chat.sessionUser;
      if (!user) {
        return JSON.stringify({
          error: "user is signed out — use propose_calendar so they can sign in and confirm",
        });
      }
      const ids = vetEventIds(input.event_ids, ctx);
      if (!ids.length)
        return JSON.stringify({
          error: "no valid event ids — use ids from the digest or search results",
        });
      const saved: string[] = [];
      let googleSynced = 0;
      for (const id of ids) {
        const result = await saveEventForUser(user, id);
        if ("error" in result) continue;
        saved.push(id);
        if (result.googleSynced) googleSynced++;
      }
      if (!saved.length) return JSON.stringify({ error: "nothing could be saved" });
      emit(config, {
        type: "action",
        action: { kind: "calendarSaved", eventIds: saved },
      });
      return JSON.stringify({
        ok: true,
        saved,
        google_synced: googleSynced,
        note: "Saved to the user's Grapevine calendar" + (googleSynced ? " and Google Calendar" : ""),
      });
    },
    {
      name: "save_calendar",
      description:
        "Save events to the user's calendar RIGHT NOW (Google Calendar too when connected). " +
        "Only after the user clearly asked to save — otherwise use propose_calendar and let them confirm.",
      schema: z.object({ event_ids: z.array(z.string()) }),
    },
  );

  const setRarityTool = tool(
    async (input, config) => {
      const result = await setEventRarity(input.event_id, input.rarity, ctx);
      if ("error" in result) return JSON.stringify(result);
      // The DB is already updated; tell the browser so badges and the
      // "Rare finds" filter reflect it without a reload.
      emit(config, {
        type: "action",
        action: { kind: "eventPatched", event: result.event },
      });
      return JSON.stringify({
        ok: true,
        id: result.event.id,
        title: result.event.title,
        rarity: result.event.rarity,
        note: result.changed ? "saved" : "already had this rarity",
      });
    },
    {
      name: "set_rarity",
      description:
        "Correct an event's rarity in the database (applies immediately, no confirmation). " +
        "rare = one-off or annual specials (parades, fireworks, races, big festivals); " +
        "notable = uncommon but repeats; common = weekly/regular. Rarity drives the app's " +
        "Rare finds filter, so fix events that are clearly mislabeled.",
      schema: z.object({
        event_id: z.string(),
        rarity: z.enum(RARITIES),
      }),
    },
  );

  const updateInterestsTool = tool(
    async (input, config) => {
      const addLoves = vetTopics(input.add_loves);
      const addAvoids = vetTopics(input.add_avoids);
      const removeLoves = vetTopics(input.remove_loves);
      const removeAvoids = vetTopics(input.remove_avoids);
      if (!addLoves.length && !addAvoids.length && !removeLoves.length && !removeAvoids.length)
        return JSON.stringify({
          error: `no valid topics — use only: ${INTEREST_TOPICS.join(", ")}`,
        });
      emit(config, {
        type: "action",
        action: {
          kind: "proposeInterests",
          addLoves,
          addAvoids,
          removeLoves,
          removeAvoids,
          reason: String(input.reason ?? "").slice(0, 160),
        },
      });
      return "Interest update proposed; the user will confirm.";
    },
    {
      name: "update_interests",
      description:
        "Propose durable taste changes (the user confirms). Use only for lasting preferences the user states, never for one-off queries. Topics must come from the fixed list in the system prompt.",
      schema: z.object({
        add_loves: z.array(z.string()).optional(),
        add_avoids: z.array(z.string()).optional(),
        remove_loves: z.array(z.string()).optional(),
        remove_avoids: z.array(z.string()).optional(),
        reason: z.string().describe("One short sentence shown to the user"),
      }),
    },
  );

  return [
    searchTool,
    getEventTool,
    etaTool,
    webSearchTool,
    readPageTool,
    discoverTool,
    showOnMapTool,
    setFiltersTool,
    proposeCalendarTool,
    saveCalendarTool,
    setRarityTool,
    updateInterestsTool,
  ];
}

export type AgentTool = ReturnType<typeof makeTools>[number];

/** Short human label for the tool-status line in the chat UI. */
export function toolLabel(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case "search_events": {
      const bits = [args.query, args.date_from, args.free_only && "free"].filter(Boolean);
      return bits.length ? `Searching: ${bits.join(" · ")}` : "Searching events";
    }
    case "get_event":
      return "Reading details";
    case "get_eta":
      return "Checking traffic";
    case "search_web":
      return args.query ? `Searching the web: ${String(args.query).slice(0, 60)}` : "Searching the web";
    case "read_page": {
      try {
        return `Reading ${new URL(String(args.url)).hostname.replace(/^www\./, "")}`;
      } catch {
        return "Reading a page";
      }
    }
    case "discover_events":
      return args.commit === true
        ? `Adding verified events: ${String(args.query ?? "").slice(0, 50)}`
        : `Scouting the web: ${String(args.query ?? "").slice(0, 50)}`;
    case "show_on_map":
      return "Pinning the map";
    case "set_filters":
      return args.note ? `Filtering: ${String(args.note).slice(0, 50)}` : "Updating map filters";
    case "propose_calendar":
      return "Drafting a calendar save";
    case "save_calendar":
      return "Saving to your calendar";
    case "set_rarity":
      return args.rarity ? `Marking as ${String(args.rarity)}` : "Updating rarity";
    case "update_interests":
      return "Noting your taste";
    default:
      return name;
  }
}

/** Derives the short "done" detail ("3 results", "12 min") from tool output. */
export function toolDetail(name: string, content: unknown): string | undefined {
  if (typeof content !== "string") return undefined;
  try {
    const parsed = JSON.parse(content);
    if (name === "search_events" && typeof parsed.count === "number") {
      return `${parsed.count} result${parsed.count === 1 ? "" : "s"}`;
    }
    if (name === "search_web" && typeof parsed.count === "number") {
      return `${parsed.count} result${parsed.count === 1 ? "" : "s"}`;
    }
    if (name === "read_page" && typeof parsed.text === "string") {
      return `${Math.round(parsed.text.length / 100) / 10}k chars`;
    }
    if (name === "get_eta" && typeof parsed.minutes === "number") {
      return `${parsed.minutes} min`;
    }
    if (name === "set_rarity" && parsed.ok) {
      return String(parsed.rarity);
    }
    if (name === "save_calendar" && parsed.ok) {
      return `${parsed.saved.length} saved`;
    }
    if (name === "set_filters" && parsed.ok) {
      return "applied";
    }
    if (name === "discover_events" && typeof parsed.added === "number") {
      return parsed.committed
        ? `${parsed.added} added`
        : `${parsed.verified?.length ?? 0} verified (preview)`;
    }
    if (parsed.error) return "failed";
  } catch {
    if (name === "show_on_map") {
      const m = /^Highlighted (\d+)/.exec(content);
      if (m) return `${m[1]} pinned`;
    }
  }
  return undefined;
}
