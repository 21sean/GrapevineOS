/**
 * Grapevine as an MCP server — lets Claude (Claude Code, Claude Desktop, or
 * any MCP client) drive this app's tools directly: search events, look up
 * details, ETAs, save to the calendar, tune interests, and run verified
 * web discovery (including managing its scheduled searches).
 *
 * Transport: Streamable HTTP at POST /mcp, stateless (a fresh server+transport
 * pair per request — no session bookkeeping, works across server restarts).
 *
 * Auth is OAuth 2.1, with Supabase Auth as the authorization server (the same
 * one the web app signs in with). The pieces:
 *   - RFC 9728 protected-resource metadata at
 *     /.well-known/oauth-protected-resource[/mcp], pointing at Supabase's
 *     issuer — whose RFC 8414 discovery advertises /authorize + /token with
 *     PKCE and dynamic client registration (RFC 7591).
 *   - Unauthenticated requests get 401 + WWW-Authenticate: Bearer
 *     resource_metadata="…", which is what makes an MCP client (Claude
 *     Desktop / claude.ai connectors, Claude Code) open the browser consent
 *     flow on its own — the connector dialog needs nothing but the /mcp URL.
 *   - Access tokens are ordinary Supabase JWTs, verified locally against the
 *     project JWKS. Each caller acts as the Grapevine account they signed in
 *     with — calendar saves and interest writes are per-user now.
 *
 * Headless fallbacks: AGENT_API_KEY as X-Agent-Key/Bearer still works for
 * scripts (and the in-process CLI loopback uses a per-boot internal key);
 * writes on that path act on AGENT_USER_EMAIL, same as /api/ext/v1. The old
 * ?key= query-param auth is gone — OAuth covers the URL-only connector case
 * it existed for.
 *
 * The endpoint answers CORS preflights so browser-based MCP clients (e.g. the
 * MCP inspector) work too; GET/DELETE return 405 as the spec allows for
 * stateless servers.
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
  RARITIES,
  searchEvents,
  searchShape,
  setEventRarity,
  vetTopics,
  type SearchParams,
} from "./agent/context.js";
import { INTERNAL_MCP_KEY, ISSUER, userFromClaims, verifySupabaseToken } from "./auth.js";
import { removeEventForUser, saveEventForUser } from "./calendar.js";
import { runDiscovery } from "./discovery.js";
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
    name: "set_event_rarity",
    description:
      "Set an event's rarity in the database (applies immediately). rare = one-off or annual specials (parades, fireworks, races, big festivals); notable = uncommon but repeats; common = weekly/regular. Rarity drives the app's Rare finds filter.",
    inputSchema: {
      type: "object",
      properties: {
        event_id: { type: "string" },
        rarity: { type: "string", enum: [...RARITIES] },
      },
      required: ["event_id", "rarity"],
    },
  },
  {
    name: "discover_events",
    description:
      "Search the open web for local events and add verified ones to the catalog. Each candidate is verified against the page it came from (dates, venue, a supporting quote) before anything is written; unverified candidates are reported with the rejection reason. Defaults to a dry run — call again with dry_run:false to commit, ideally after the user confirms.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: 'what to look for, e.g. "jazz shows this weekend" (the city is appended automatically)',
        },
        dry_run: {
          type: "boolean",
          description: "default true — verify and report without writing; false commits verified events",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "list_scheduled_searches",
    description:
      "Saved web-discovery searches the server re-runs automatically, with cadence, last run time, and last result summary.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "schedule_search",
    description:
      "Save a web-discovery search the server re-runs on a schedule (verified events land on the map automatically). Re-saving an existing query updates its cadence.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "3-200 chars" },
        cadence_hours: {
          type: "number",
          description: "hours between runs, 1-336 (default 24; 168 = weekly)",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "unschedule_search",
    description: "Delete a scheduled web-discovery search by id (from list_scheduled_searches) or exact query text.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        query: { type: "string", description: "alternative to id — exact query text, case-insensitive" },
      },
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

/**
 * The account MCP writes act on. OAuth callers carry their own user (from the
 * verified token); key-authed and open-mode callers fall back to the account
 * named by AGENT_USER_EMAIL, same as /api/ext/v1.
 */
async function boundUser(oauthUser: User | null): Promise<User | { error: string }> {
  if (oauthUser) return oauthUser;
  const email = process.env.AGENT_USER_EMAIL;
  if (!email) return { error: "set AGENT_USER_EMAIL in server/.env to enable calendar/interest writes" };
  const user = await store.userByEmail(email);
  if (!user) return { error: `no Grapevine account for ${email} — sign in on the web app once first` };
  return user;
}

async function callTool(name: string, args: Record<string, unknown>, oauthUser: User | null) {
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
      const user = await boundUser(oauthUser);
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
      const user = await boundUser(oauthUser);
      if ("error" in user) return fail(user.error);
      const id = String(args.event_id ?? "");
      const result =
        name === "save_event"
          ? await saveEventForUser(user, id)
          : await removeEventForUser(user, id);
      return "error" in result ? fail(result.error) : ok(result);
    }
    case "set_event_rarity": {
      const result = await setEventRarity(args.event_id, args.rarity, ctx);
      if ("error" in result) return fail(result.error);
      return ok({
        id: result.event.id,
        title: result.event.title,
        rarity: result.event.rarity,
        changed: result.changed,
      });
    }
    case "discover_events": {
      const query = String(args.query ?? "").trim();
      if (query.length < 3) return fail("query required (3+ chars)");
      const result = await runDiscovery({ query, commit: args.dry_run === false });
      if (result.error) return fail(`discovery failed: ${result.error}`);
      // Compact shape: verdicts and evidence stay, page text never leaves.
      const shape = (c: (typeof result.verified)[number]) => ({
        id: c.event.id,
        title: c.event.title,
        start: c.event.start,
        venue: c.event.venue,
        price: c.event.price,
        verdict: c.verdict,
        confidence: c.confidence,
        ...(c.evidence && { evidence: c.evidence }),
        ...(c.reason && { reason: c.reason }),
        source_url: c.sourceUrl,
        corroborations: c.corroborations,
      });
      return ok({
        query: result.query,
        dry_run: args.dry_run !== false,
        pages_read: result.pagesRead,
        extracted: result.extracted,
        added: result.added,
        verified: result.verified.map(shape),
        rejected: result.rejected.map(shape),
      });
    }
    case "list_scheduled_searches": {
      const searches = await store.discoverySearches();
      return ok({ count: searches.length, searches });
    }
    case "schedule_search": {
      const query = String(args.query ?? "").trim();
      if (query.length < 3 || query.length > 200) return fail("query must be 3-200 chars");
      const n = Number(args.cadence_hours);
      const cadence = Number.isFinite(n) ? Math.min(Math.max(1, Math.round(n)), 336) : 24;
      const saved = await store.addDiscoverySearch(query, cadence);
      return ok({ scheduled: true, ...saved });
    }
    case "unschedule_search": {
      let id = typeof args.id === "string" ? args.id : "";
      if (!id && typeof args.query === "string") {
        const q = args.query.trim().toLowerCase();
        id = (await store.discoverySearches()).find((s) => s.query.toLowerCase() === q)?.id ?? "";
      }
      if (!id) return fail("give id or the exact query of a scheduled search");
      const deleted = await store.deleteDiscoverySearch(id);
      return deleted ? ok({ deleted: true, id }) : fail("unknown scheduled search");
    }
    case "update_interests": {
      const user = await boundUser(oauthUser);
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

function buildServer(oauthUser: User | null): Server {
  const server = new Server(SERVER_INFO, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    try {
      return await callTool(req.params.name, req.params.arguments ?? {}, oauthUser);
    } catch (err) {
      return fail(String(err).slice(0, 300));
    }
  });
  return server;
}

// ---------------------------------------------------------------------------
// HTTP wiring
// ---------------------------------------------------------------------------

/** "oauth" unless MCP_OPEN=1 restores the old unauthenticated behavior. */
export function mcpAuthMode(): "oauth" | "open" {
  return process.env.MCP_OPEN === "1" ? "open" : "oauth";
}

const RESOURCE_METADATA_PATH = "/.well-known/oauth-protected-resource";

/**
 * The origin MCP clients reached us on. MCP_PUBLIC_URL wins when set (tunnel
 * or reverse proxy); otherwise trust the request itself — index.ts enables
 * "trust proxy" so X-Forwarded-Proto from a tunnel yields https here.
 */
function publicOrigin(req: Request): string {
  const base = process.env.MCP_PUBLIC_URL ?? `${req.protocol}://${req.get("host")}`;
  return base.replace(/\/$/, "");
}

declare module "express-serve-static-core" {
  interface Request {
    /** Set by mcpAuth when the caller presented a valid Supabase JWT. */
    mcpUser?: User;
  }
}

/**
 * OAuth 2.1 resource auth. Order matters: a Bearer value is first tried as a
 * Supabase JWT (per-user), then as the shared agent key (headless scripts).
 * Anything else gets the RFC 9728 challenge that kicks MCP clients into the
 * browser consent flow.
 */
async function mcpAuth(req: Request, res: Response, next: () => void) {
  const header = req.get("Authorization") ?? "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7) : undefined;
  if (bearer) {
    const user = await userFromClaims(await verifySupabaseToken(bearer));
    if (user) {
      req.mcpUser = user;
      return next();
    }
  }
  const given = req.get("X-Agent-Key") ?? bearer;
  const key = process.env.AGENT_API_KEY;
  if (given && ((key && given === key) || given === INTERNAL_MCP_KEY)) return next();
  if (mcpAuthMode() === "open") return next(); // explicit MCP_OPEN=1 opt-in
  res.setHeader(
    "WWW-Authenticate",
    `Bearer resource_metadata="${publicOrigin(req)}${RESOURCE_METADATA_PATH}"`,
  );
  return res.status(401).json({
    error:
      "unauthorized — sign in via OAuth (see the WWW-Authenticate resource_metadata) or send AGENT_API_KEY as X-Agent-Key",
  });
}

/**
 * CORS for browser-based MCP clients (the MCP inspector, web apps). Claude's
 * own connector client calls server-to-server and ignores this. The wildcard
 * origin grants nothing by itself — auth still rides on every request.
 */
function mcpCors(req: Request, res: Response, next: () => void) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, DELETE, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Agent-Key, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID",
  );
  res.setHeader(
    "Access-Control-Expose-Headers",
    "Mcp-Session-Id, Mcp-Protocol-Version, WWW-Authenticate",
  );
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
}

export const mcp = Router();

mcp.use("/mcp", mcpCors);
mcp.use(RESOURCE_METADATA_PATH, mcpCors);
mcp.use("/.well-known/oauth-authorization-server", mcpCors);

/**
 * RFC 9728 protected-resource metadata — the discovery document the 401
 * challenge points at. Both the bare path and the /mcp-suffixed variant are
 * served: clients derive the latter from the resource URL's path (RFC 9728
 * §3), and Claude tries it first.
 */
mcp.get([RESOURCE_METADATA_PATH, `${RESOURCE_METADATA_PATH}/mcp`], (req, res) => {
  res.json({
    resource: `${publicOrigin(req)}/mcp`,
    authorization_servers: [ISSUER],
    bearer_methods_supported: ["header"],
    resource_name: "Grapevine",
    scopes_supported: ["openid", "email", "profile"],
  });
});

/**
 * Compatibility shim for pre-2025-06-18 MCP clients that skip resource
 * metadata and fetch RFC 8414 authorization-server metadata straight from the
 * MCP origin. Mirrors Supabase's document (cached; refetched hourly).
 */
let asMetadata: { body: unknown; at: number } | null = null;
mcp.get("/.well-known/oauth-authorization-server", async (_req, res) => {
  try {
    if (!asMetadata || Date.now() - asMetadata.at > 3_600_000) {
      const url = ISSUER.replace("/auth/v1", "/.well-known/oauth-authorization-server/auth/v1");
      const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!r.ok) throw new Error(`upstream ${r.status}`);
      asMetadata = { body: await r.json(), at: Date.now() };
    }
    res.json(asMetadata.body);
  } catch (err) {
    res.status(502).json({ error: `authorization server metadata unavailable: ${String(err).slice(0, 120)}` });
  }
});

mcp.post("/mcp", mcpAuth, async (req, res) => {
  // Stateless: fresh pair per request so concurrent clients can't collide.
  const server = buildServer(req.mcpUser ?? null);
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
