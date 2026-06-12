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
import { CATEGORIES, type Category } from "../types.js";
import {
  INTEREST_TOPICS,
  getEta,
  getEvent,
  searchEvents,
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
    showOnMapTool,
    proposeCalendarTool,
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
    case "show_on_map":
      return "Pinning the map";
    case "propose_calendar":
      return "Drafting a calendar save";
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
    if (parsed.error) return "failed";
  } catch {
    if (name === "show_on_map") {
      const m = /^Highlighted (\d+)/.exec(content);
      if (m) return `${m[1]} pinned`;
    }
  }
  return undefined;
}
