/**
 * Grapevine as an MCP server — lets Claude (Claude Code, Claude Desktop, or
 * any MCP client) drive this app's tools directly: search events, look up
 * details, ETAs, save to the calendar, tune interests.
 *
 * Transport: Streamable HTTP at POST /mcp, stateless (a fresh server+transport
 * pair per request — no session bookkeeping, works across server restarts).
 * Auth mirrors the app's local-first stance: open when AGENT_API_KEY is unset,
 * otherwise the key must arrive as X-Agent-Key or a Bearer token. Writes act
 * on the account named by AGENT_USER_EMAIL, same as /api/ext/v1.
 *
 * Tool schemas are plain JSON Schema via the low-level Server API, sharing the
 * executors in agent/context.ts with the in-app agent and the ext REST API.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Router, type Request, type Response } from "express";
import {
  buildCtx,
  getEta,
  getEvent,
  INTEREST_TOPICS,
  parseLngLat,
  searchEvents,
  searchShape,
  vetTopics,
  type SearchParams,
} from "./agent/context.js";
import { removeEventForUser, saveEventForUser } from "./calendar.js";
import { store } from "./store.js";
import type { User } from "./types.js";

export const SERVER_INFO = { name: "grapevine", version: "0.1.0" };

const TOOLS = [
  {
    name: "search_events",
    description:
      "Search upcoming local events (community-sourced, next occurrence per event). Returns id, title, venue, time, price, buzz rating. Use the returned ids with the other tools.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "free-text match on title/description/venue/tags" },
        categories: {
          type: "array",
          items: { type: "string", enum: ["music", "food", "sports", "arts", "market", "festival", "community"] },
        },
        tags: { type: "array", items: { type: "string" } },
        date_from: { type: "string", description: "YYYY-MM-DD (city-local)" },
        date_to: { type: "string", description: "YYYY-MM-DD (city-local)" },
        free_only: { type: "boolean" },
        min_rating: { type: "number", description: "1-5 buzz floor" },
        exclude_promoted: { type: "boolean", description: "default true — hides paid placements" },
        near: { type: "string", description: 'place name or "lng,lat" to sort/filter by distance' },
        max_km: { type: "number" },
        sort: { type: "string", enum: ["time", "buzz", "distance"] },
        limit: { type: "number", description: "1-20, default 8" },
      },
    },
  },
  {
    name: "get_event",
    description: "Full detail for one event: description, address, ticket link, rating rationale, coordinates.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
  {
    name: "get_eta",
    description: "Driving ETA to an event (or coordinates), defaulting from the city center.",
    inputSchema: {
      type: "object",
      properties: {
        to_event_id: { type: "string" },
        to: { type: "string", description: '"lng,lat" — alternative to to_event_id' },
        from: { type: "string", description: '"lng,lat" origin (default: city center)' },
      },
    },
  },
  {
    name: "list_saved_events",
    description: "Events on the linked Grapevine account's calendar.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "save_event",
    description: "Save an event to the linked account's calendar (syncs to Google Calendar when connected).",
    inputSchema: {
      type: "object",
      properties: { event_id: { type: "string" } },
      required: ["event_id"],
    },
  },
  {
    name: "unsave_event",
    description: "Remove an event from the linked account's calendar.",
    inputSchema: {
      type: "object",
      properties: { event_id: { type: "string" } },
      required: ["event_id"],
    },
  },
  {
    name: "update_interests",
    description: `Tune the linked account's taste profile. Allowed topics: ${INTEREST_TOPICS.join(", ")}.`,
    inputSchema: {
      type: "object",
      properties: {
        addLoves: { type: "array", items: { type: "string" } },
        addAvoids: { type: "array", items: { type: "string" } },
        removeLoves: { type: "array", items: { type: "string" } },
        removeAvoids: { type: "array", items: { type: "string" } },
      },
    },
  },
];

function ok(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}

function fail(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

/** The account MCP writes act on — bound by env, never by the caller. */
async function boundUser(): Promise<User | { error: string }> {
  const email = process.env.AGENT_USER_EMAIL;
  if (!email) return { error: "set AGENT_USER_EMAIL in server/.env to enable calendar/interest writes" };
  const user = await store.userByEmail(email);
  if (!user) return { error: `no Grapevine account for ${email} — sign in on the web app once first` };
  return user;
}

async function callTool(name: string, args: Record<string, unknown>) {
  const ctx = await buildCtx();
  switch (name) {
    case "search_events": {
      const near = typeof args.near === "string" ? args.near : undefined;
      const result = await searchEvents(
        {
          query: args.query as string | undefined,
          categories: args.categories as string[] | undefined,
          tags: args.tags as string[] | undefined,
          date_from: args.date_from as string | undefined,
          date_to: args.date_to as string | undefined,
          free_only: args.free_only as boolean | undefined,
          min_rating: args.min_rating as number | undefined,
          exclude_promoted: args.exclude_promoted as boolean | undefined,
          near,
          max_km: args.max_km as number | undefined,
          sort: args.sort as SearchParams["sort"],
          limit: args.limit as number | undefined,
        },
        ctx,
      );
      return ok({ city: ctx.settings.city, tz: ctx.settings.tz, ...result });
    }
    case "get_event": {
      const result = getEvent(String(args.id ?? ""), ctx);
      return "error" in result ? fail(String(result.error)) : ok(result);
    }
    case "get_eta": {
      const to = typeof args.to === "string" ? parseLngLat(args.to) : undefined;
      const from = typeof args.from === "string" ? parseLngLat(args.from) : undefined;
      const result = await getEta(
        { to_event_id: args.to_event_id as string | undefined, to, from },
        ctx,
      );
      return "error" in result ? fail(String(result.error)) : ok(result);
    }
    case "list_saved_events": {
      const user = await boundUser();
      if ("error" in user) return fail(user.error);
      const entries = await store.userCalendar(user.id);
      const events = entries
        .map((entry) => ctx.byId.get(entry.eventId))
        .filter((hit): hit is NonNullable<typeof hit> => !!hit)
        .map(({ e, occ }) => searchShape(e, occ, ctx.settings.tz));
      return ok({ count: events.length, events });
    }
    case "save_event":
    case "unsave_event": {
      const user = await boundUser();
      if ("error" in user) return fail(user.error);
      const id = String(args.event_id ?? "");
      const result =
        name === "save_event"
          ? await saveEventForUser(user, id)
          : await removeEventForUser(user, id);
      return "error" in result ? fail(result.error) : ok(result);
    }
    case "update_interests": {
      const user = await boundUser();
      if ("error" in user) return fail(user.error);
      const addLoves = vetTopics(args.addLoves);
      const addAvoids = vetTopics(args.addAvoids);
      const removeLoves = vetTopics(args.removeLoves);
      const removeAvoids = vetTopics(args.removeAvoids);
      if (!addLoves.length && !addAvoids.length && !removeLoves.length && !removeAvoids.length)
        return fail(`no valid topics — allowed: ${INTEREST_TOPICS.join(", ")}`);
      const current = (user.prefs?.interests ?? {}) as { loves?: string[]; avoids?: string[] };
      // A topic can't be loved and avoided at once — the newer signal wins.
      const loves = [
        ...new Set([
          ...(current.loves ?? []).filter((t) => !removeLoves.includes(t) && !addAvoids.includes(t)),
          ...addLoves,
        ]),
      ];
      const avoids = [
        ...new Set([
          ...(current.avoids ?? []).filter((t) => !removeAvoids.includes(t) && !addLoves.includes(t)),
          ...addAvoids,
        ]),
      ];
      const updated = await store.updateUserPrefs(user.id, { interests: { loves, avoids } });
      return ok({ interests: updated?.prefs?.interests ?? { loves, avoids } });
    }
    default:
      return fail(`unknown tool ${name}`);
  }
}

function buildServer(): Server {
  const server = new Server(SERVER_INFO, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    try {
      return await callTool(req.params.name, req.params.arguments ?? {});
    } catch (err) {
      return fail(String(err).slice(0, 300));
    }
  });
  return server;
}

// ---------------------------------------------------------------------------
// HTTP wiring
// ---------------------------------------------------------------------------

export function mcpKeyRequired(): boolean {
  return !!process.env.AGENT_API_KEY;
}

function mcpAuth(req: Request, res: Response, next: () => void) {
  const key = process.env.AGENT_API_KEY;
  if (!key) return next(); // local-first: open like the rest of the HTTP API
  const given =
    req.get("X-Agent-Key") ?? req.get("Authorization")?.replace(/^Bearer\s+/i, "");
  if (given !== key) return res.status(401).json({ error: "bad agent key" });
  next();
}

export const mcp = Router();

mcp.post("/mcp", mcpAuth, async (req, res) => {
  // Stateless: fresh pair per request so concurrent clients can't collide.
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: String(err).slice(0, 200) },
        id: null,
      });
    }
  }
});

// Stateless server: no SSE notification stream, no sessions to delete.
const methodNotAllowed = (_req: Request, res: Response) =>
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed (stateless MCP server)" },
    id: null,
  });
mcp.get("/mcp", mcpAuth, methodNotAllowed);
mcp.delete("/mcp", mcpAuth, methodNotAllowed);
