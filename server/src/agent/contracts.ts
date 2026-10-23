/**
 * The agent's tool contracts, declared once.
 *
 * Every surface derives from this table instead of restating it:
 *   - the LangGraph toolbox (tools.ts) binds the "graph" contracts to executors
 *   - the MCP server (mcp.ts) publishes the "mcp" contracts, annotations included
 *   - the external REST API (agent/ext.ts) and the discovery router
 *     (routes/discovery.ts) parse bodies and query strings with these schemas
 *   - the OpenClaw skill file is generated from it (scripts/contracts-gen.ts)
 *     and the CLI providers' tool note is built from it at run time
 *
 * Four things that had drifted between the copies are settled here, once:
 * lngLat is one type on every surface; discovery is dry_run (default true)
 * everywhere; rarity is set_rarity everywhere; and update_interests only ever
 * proposes. The write is apply_interests, which demands confirmed: true, so
 * the human-in-the-loop story is the same whether the caller is the browser,
 * Claude Desktop, or a curl script.
 *
 * Import-light on purpose: zod and the shared types only, so the generator,
 * the tests, and the CLI prompt builder can load it without booting the
 * database or the graph.
 */
import { z } from "zod";
import { toolSchemas } from "../llm/generated.js";
import { INTEREST_TOPICS } from "../types.js";

/** Where a tool is exposed. A tool can be on several surfaces at once. */
export type Surface = "graph" | "mcp" | "rest";

/**
 * What calling the tool does to the world. `read` answers a question; `ui`
 * changes what the browser shows and nothing else; `propose` shows the user a
 * card they confirm; `write` changes stored data now.
 */
export type Effect = "read" | "ui" | "propose" | "write";

export interface ToolContract<S extends z.ZodObject = z.ZodObject> {
  name: string;
  /** One paragraph for the model and the MCP client alike. */
  description: string;
  schema: S;
  surfaces: readonly Surface[];
  effect: Effect;
  /** Reaches the open web (the MCP openWorldHint). */
  openWorld?: boolean;
  /** Short status line for the chat UI while the call runs. */
  label: (args: Record<string, unknown>) => string;
  /** Short "done" detail from the tool's result, when one is worth showing. */
  detail?: (result: Record<string, unknown>) => string | undefined;
}

export type AnyContract = ToolContract<z.ZodObject<any>>;

/** Keeps each contract's schema and surface tuple as their literal types. */
function contract<S extends z.ZodObject, const T extends readonly Surface[]>(
  c: Omit<ToolContract<S>, "surfaces"> & { surfaces: T },
): ToolContract<S> & { surfaces: T } {
  return c;
}

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

/** "lng,lat" as a string, the shape query strings and older clients send. */
export const LNG_LAT_STRING = /^\s*-?\d+(\.\d+)?\s*,\s*-?\d+(\.\d+)?\s*$/;

/**
 * One coordinate type on every surface. The executors accept both shapes
 * (context.ts anyLngLat), so the coercion lives in one place too.
 */
export const lngLat = z
  .union([z.tuple([z.number(), z.number()]), z.string().regex(LNG_LAT_STRING)])
  .describe('[lng, lat], or the same pair as a "lng,lat" string');

const TOPICS = INTEREST_TOPICS.join(", ");

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;
const clip = (v: unknown, n: number) => String(v ?? "").slice(0, n);

// ---------------------------------------------------------------------------
// The contracts
// ---------------------------------------------------------------------------

export const CONTRACTS = {
  search_events: contract({
    name: "search_events",
    description:
      "Search the live event set: upcoming local events, one row per event at its next occurrence. All filters are optional; omit them for the top upcoming events. Dates are city-local YYYY-MM-DD. Returns id, title, venue, time, price and buzz rating; use the ids with the other tools.",
    schema: toolSchemas.search_events,
    surfaces: ["graph", "mcp", "rest"],
    effect: "read",
    label: (a) => {
      const bits = [a.query, a.date_from, a.free_only && "free"].filter(Boolean);
      return bits.length ? `Searching: ${bits.join(" · ")}` : "Searching events";
    },
    detail: (r) => (typeof r.count === "number" ? plural(r.count, "result") : undefined),
  }),

  get_event: contract({
    name: "get_event",
    description:
      "Full detail for one event: description, address, ticket link, buzz rationale and coordinates.",
    schema: toolSchemas.get_event,
    surfaces: ["graph", "mcp", "rest"],
    effect: "read",
    label: () => "Reading details",
  }),

  get_eta: contract({
    name: "get_eta",
    description:
      "Traffic-aware driving ETA. Give to_event_id (preferred) or to coordinates; from defaults to the user's location when known, else the city center.",
    schema: toolSchemas.get_eta,
    surfaces: ["graph", "mcp", "rest"],
    effect: "read",
    label: () => "Checking traffic",
    detail: (r) => (typeof r.minutes === "number" ? `${r.minutes} min` : undefined),
  }),

  search_web: contract({
    name: "search_web",
    description:
      "Search the live web (keyless local metasearch: SearXNG or DuckDuckGo). Use for anything the event catalog cannot answer: artist background, venue details or hours, weather, news. Returns titles, urls and snippets.",
    schema: toolSchemas.search_web,
    surfaces: ["graph"],
    effect: "read",
    openWorld: true,
    label: (a) => (a.query ? `Searching the web: ${clip(a.query, 60)}` : "Searching the web"),
    detail: (r) => (typeof r.count === "number" ? plural(r.count, "result") : undefined),
  }),

  read_page: contract({
    name: "read_page",
    description:
      "Fetch one web page and return its readable text (reader-mode extraction, truncated). Use on the most promising search_web result when snippets are not enough.",
    schema: toolSchemas.read_page,
    surfaces: ["graph"],
    effect: "read",
    openWorld: true,
    label: (a) => {
      try {
        return `Reading ${new URL(String(a.url)).hostname.replace(/^www\./, "")}`;
      } catch {
        return "Reading a page";
      }
    },
    detail: (r) =>
      typeof r.text === "string" ? `${Math.round(r.text.length / 100) / 10}k chars` : undefined,
  }),

  discover_events: contract({
    name: "discover_events",
    description:
      "Search the open web for local events and add verified ones to the catalog (the user's list and map). Every candidate is verified against the page it came from (dates, venue, a supporting quote) before anything is written; unverified candidates come back with the rejection reason. Slow: several pages are read and cross-checked. Defaults to a dry run that reports what it found; call again with dry_run:false once the user asks for the events to be added.",
    schema: toolSchemas.discover_events,
    surfaces: ["graph", "mcp", "rest"],
    effect: "write",
    openWorld: true,
    label: (a) =>
      a.dry_run === false
        ? `Adding verified events: ${clip(a.query, 50)}`
        : `Scouting the web: ${clip(a.query, 50)}`,
    detail: (r) =>
      typeof r.added === "number"
        ? r.dry_run === false
          ? `${r.added} added`
          : `${Array.isArray(r.verified) ? r.verified.length : 0} verified (preview)`
        : undefined,
  }),

  show_on_map: contract({
    name: "show_on_map",
    description:
      "Highlight events on the user's map and fly the camera to them. Call after choosing which events to recommend.",
    schema: toolSchemas.show_on_map,
    surfaces: ["graph"],
    effect: "ui",
    label: () => "Pinning the map",
    detail: (r) => (typeof r.pinned === "number" ? `${r.pinned} pinned` : undefined),
  }),

  set_filters: contract({
    name: "set_filters",
    description:
      'Change the filters on the user\'s live map ("free stuff this weekend", "only music", "hide farmers markets"). Only pass the knobs the user asked about; the rest keep their values. reset:true clears everything back to defaults first.',
    schema: toolSchemas.set_filters,
    surfaces: ["graph"],
    effect: "ui",
    label: (a) => (a.note ? `Filtering: ${clip(a.note, 50)}` : "Updating map filters"),
    detail: (r) => (r.ok ? "applied" : undefined),
  }),

  propose_calendar: contract({
    name: "propose_calendar",
    description:
      "Show the user a save-to-calendar card for the given events. The user confirms; never claim anything is saved.",
    schema: toolSchemas.propose_calendar,
    surfaces: ["graph"],
    effect: "propose",
    label: () => "Drafting a calendar save",
  }),

  propose_watch: contract({
    name: "propose_watch",
    description:
      'Offer to keep watching the web for a topic on the user\'s behalf: a card the user confirms schedules a recurring discovery search (daily by default) whose verified finds land on the map automatically. Use when the user wants to be kept posted ("watch for jazz shows", "keep looking for pop-ups"), not for a one-off question. The user confirms; never claim a watch is set.',
    schema: toolSchemas.propose_watch,
    surfaces: ["graph"],
    effect: "propose",
    label: (a) => (a.query ? `Offering a watch: ${clip(a.query, 50)}` : "Offering a watch"),
  }),

  save_calendar: contract({
    name: "save_calendar",
    description:
      "Save events to the user's calendar right now (Google Calendar too when connected). Only after the user clearly asked to save; otherwise use propose_calendar and let them confirm.",
    schema: toolSchemas.save_calendar,
    surfaces: ["graph"],
    effect: "write",
    label: () => "Saving to your calendar",
    detail: (r) => (r.ok && Array.isArray(r.saved) ? `${r.saved.length} saved` : undefined),
  }),

  list_saved_events: contract({
    name: "list_saved_events",
    description: "Events on the linked Grapevine account's calendar.",
    schema: toolSchemas.list_saved_events,
    surfaces: ["mcp", "rest"],
    effect: "read",
    label: () => "Reading your calendar",
  }),

  save_event: contract({
    name: "save_event",
    description:
      "Save one event to the linked account's calendar (syncs to Google Calendar when connected). Confirm with the user first.",
    schema: toolSchemas.save_event,
    surfaces: ["mcp", "rest"],
    effect: "write",
    label: () => "Saving to your calendar",
  }),

  unsave_event: contract({
    name: "unsave_event",
    description:
      "Remove one event from the linked account's calendar. Confirm with the user first.",
    schema: toolSchemas.unsave_event,
    surfaces: ["mcp", "rest"],
    effect: "write",
    label: () => "Removing from your calendar",
  }),

  set_rarity: contract({
    name: "set_rarity",
    description:
      "Correct an event's rarity in the database (applies immediately, no confirmation). rare = one-off or annual specials (parades, fireworks, races, big festivals); notable = uncommon but repeats; common = weekly or regular. Rarity drives the app's Rare finds filter, so fix events that are clearly mislabeled and leave the rest alone.",
    schema: toolSchemas.set_rarity,
    surfaces: ["graph", "mcp", "rest"],
    effect: "write",
    label: (a) => (a.rarity ? `Marking as ${String(a.rarity)}` : "Updating rarity"),
    detail: (r) =>
      r.ok || r.changed !== undefined ? String(r.rarity ?? "") || undefined : undefined,
  }),

  update_interests: contract({
    name: "update_interests",
    description: `Propose durable taste changes for the user to confirm. Use only for lasting preferences the user states, never for one-off queries. Topics must come from this list: ${TOPICS}. Nothing is written by this tool: in the app the user confirms a card; elsewhere, show the returned proposal and call apply_interests with confirmed:true once they agree.`,
    schema: toolSchemas.update_interests,
    surfaces: ["graph", "mcp", "rest"],
    effect: "propose",
    label: () => "Noting your taste",
  }),

  apply_interests: contract({
    name: "apply_interests",
    description: `Write a taste change the user has already confirmed. Same arguments as update_interests plus confirmed:true, which is required: a call without it is refused. Topics: ${TOPICS}.`,
    schema: toolSchemas.apply_interests,
    surfaces: ["mcp", "rest"],
    effect: "write",
    label: () => "Updating your taste",
  }),

  list_scheduled_searches: contract({
    name: "list_scheduled_searches",
    description:
      "Saved web-discovery searches the server re-runs automatically, with cadence, last run time and last result summary. In the app this lists the signed-in user's own watches.",
    schema: toolSchemas.list_scheduled_searches,
    surfaces: ["graph", "mcp", "rest"],
    effect: "read",
    label: () => "Listing your watches",
    detail: (r) => (typeof r.count === "number" ? plural(r.count, "watch") : undefined),
  }),

  schedule_search: contract({
    name: "schedule_search",
    description:
      "Save a web-discovery search the server re-runs on a schedule; verified events land on the map automatically. Re-saving an existing query updates its cadence. Confirm with the user first.",
    schema: toolSchemas.schedule_search,
    surfaces: ["mcp", "rest"],
    effect: "write",
    label: () => "Scheduling a search",
  }),

  update_scheduled_search: contract({
    name: "update_scheduled_search",
    description:
      "Pause, resume or re-pace one scheduled search by id: active:false pauses it, cadence_hours changes how often it runs.",
    schema: toolSchemas.update_scheduled_search,
    surfaces: ["mcp", "rest"],
    effect: "write",
    label: () => "Updating a scheduled search",
  }),

  run_scheduled_search: contract({
    name: "run_scheduled_search",
    description:
      "Run one scheduled search immediately (commits verified events, and stamps its last-run time and status).",
    schema: toolSchemas.run_scheduled_search,
    surfaces: ["mcp", "rest"],
    effect: "write",
    label: () => "Running a scheduled search",
  }),

  unschedule_search: contract({
    name: "unschedule_search",
    description:
      "Delete a scheduled web-discovery search by id (from list_scheduled_searches) or by its exact query text. Confirm with the user first.",
    schema: toolSchemas.unschedule_search,
    surfaces: ["mcp", "rest"],
    effect: "write",
    label: () => "Removing a scheduled search",
  }),
};

export type ToolName = keyof typeof CONTRACTS;
type Present<T> = {
  [K in keyof T]: K extends "date_from" | "date_to" ? T[K] : Exclude<T[K], null>;
};
export type ToolArgs<N extends ToolName> = Present<z.infer<(typeof CONTRACTS)[N]["schema"]>>;
export function presentArgs(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).filter(
      ([key, v]) => v !== null || key === "date_from" || key === "date_to",
    ),
  );
}

/** The names exposed on one surface, as a type. */
export type ToolsOn<S extends Surface> = {
  [N in ToolName]: S extends (typeof CONTRACTS)[N]["surfaces"][number] ? N : never;
}[ToolName];

export const TOOL_LIST: AnyContract[] = Object.values(CONTRACTS);

export function toolsFor(surface: Surface): AnyContract[] {
  return TOOL_LIST.filter((c) => c.surfaces.includes(surface));
}

export function isToolName(name: string): name is ToolName {
  return Object.hasOwn(CONTRACTS, name);
}

// ---------------------------------------------------------------------------
// Derived helpers
// ---------------------------------------------------------------------------

/** Short human label for the tool-status line in the chat UI. */
export function toolLabel(name: string, args: Record<string, unknown> = {}): string {
  return isToolName(name) ? CONTRACTS[name].label(args) : name;
}

/** The short "done" detail ("3 results", "12 min") from a tool's result. */
export function toolDetail(name: string, content: unknown): string | undefined {
  if (!isToolName(name) || typeof content !== "string") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    // Plain-text results carry their own detail, e.g. "Highlighted 3 events".
    const m = /^Highlighted (\d+)/.exec(content);
    return m ? `${m[1]} pinned` : undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const record = parsed as Record<string, unknown>;
  if (record.error) return "failed";
  return CONTRACTS[name].detail?.(record);
}

/**
 * Validate raw arguments against a contract. The message names every bad
 * field at once, which is what a model or a curl user needs to fix the call.
 */
export function parseArgs<N extends ToolName>(
  name: N,
  raw: unknown,
): { ok: true; args: ToolArgs<N> } | { ok: false; error: string } {
  const result = CONTRACTS[name].schema.safeParse(raw ?? {});
  if (result.success) return { ok: true, args: presentArgs(result.data) as ToolArgs<N> };
  const error = result.error.issues
    .map((i) => `${i.path.join(".") || "body"}: ${i.message}`)
    .join("; ");
  return { ok: false, error };
}

function unwrap(t: z.ZodType): z.ZodType {
  let cur: z.ZodType = t;
  for (;;) {
    if (
      cur instanceof z.ZodOptional ||
      cur instanceof z.ZodNullable ||
      cur instanceof z.ZodDefault
    ) {
      cur = cur.unwrap() as z.ZodType;
      continue;
    }
    return cur;
  }
}

/**
 * Query strings are all text. Read a contract's shape and coerce what the
 * schema says is a boolean, a number, or a list, so GET routes parse with the
 * same schema POST routes do. Keys the schema does not know are dropped.
 */
export function coerceQuery(
  schema: z.ZodObject<any>,
  raw: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(schema.shape as Record<string, z.ZodType>)) {
    let value = raw[key];
    if (Array.isArray(value)) value = value[value.length - 1];
    if (value === undefined || value === "") continue;
    if (typeof value !== "string") {
      out[key] = value;
      continue;
    }
    const inner = unwrap(field);
    if (inner instanceof z.ZodBoolean)
      out[key] = ["1", "true", "yes"].includes(value.toLowerCase());
    else if (inner instanceof z.ZodNumber) out[key] = Number(value);
    else if (inner instanceof z.ZodArray)
      out[key] = value
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    else out[key] = value;
  }
  return out;
}

/**
 * What a CLI provider needs to hear about its toolbox. Built from the table
 * so a tool added or renamed here is described correctly on the next turn.
 */
export function cliToolsNote(): string {
  const mcp = toolsFor("mcp").map((c) => c.name);
  const appOnly = toolsFor("graph")
    .filter((c) => !c.surfaces.includes("mcp"))
    .map((c) => c.name);
  const writes = toolsFor("mcp")
    .filter((c) => c.effect === "write")
    .map((c) => c.name);
  return `Tools in this session: the "grapevine" MCP server is your entire toolbox:
${mcp.join(", ")}. You have no web search, no shell, and no file access, so
never claim to have browsed a site directly.

The in-app tools the system prompt mentions (${appOnly.join(", ")}) do NOT
exist here: never claim to have pinned the map or changed filters. Recommend
events in text with the [Title](event:id) grammar, use search_events and
get_event beyond the digest, and get_eta for travel questions.

When the user wants events that are not in the catalog yet ("find more",
"keep searching", "add events"), call discover_events. It searches the open
web and verifies each candidate against its source page before writing. It
dry-runs by default: report what it found, then call it again with
dry_run:false once the user confirms. Offer schedule_search when they want an
ongoing watch. update_interests only proposes; show the proposal, and call
apply_interests with confirmed:true when the user agrees. Every write
(${writes.join(", ")}) lands on the linked Grapevine account, so make one only
when the user asks.`;
}
