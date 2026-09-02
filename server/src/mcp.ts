/**
 * Grapevine as an MCP server — lets Claude (Claude Code, Claude Desktop, or
 * any MCP client) drive this app's tools directly: search events, look up
 * details, ETAs, save to the calendar, tune interests, and run verified
 * web discovery (including managing its scheduled searches).
 *
 * Built on FastMCP 4: tool schemas are Zod (validated before `execute` runs),
 * and the OAuth 2.1 resource layer — RFC 8414 + RFC 9728 discovery documents
 * and the 401 `WWW-Authenticate` challenge — is FastMCP's, not hand-rolled.
 *
 * Transport: Streamable HTTP at POST /mcp, stateless (a fresh session per
 * request — no session bookkeeping, works across server restarts).
 *
 * Auth is OAuth 2.1 with Supabase Auth as the authorization server (the same
 * one the web app signs in with). The pieces:
 *   - `authenticate` verifies the Bearer token locally against the project
 *     JWKS, so each caller acts as the Grapevine account they signed in with:
 *     calendar saves and interest writes are per-user.
 *   - FastMCP publishes protected-resource metadata (RFC 9728) pointing at
 *     Supabase's issuer, whose own RFC 8414 document advertises /authorize +
 *     /token with PKCE and dynamic client registration (RFC 7591). We mirror
 *     that document at our origin for pre-2025-06-18 clients that skip
 *     resource metadata.
 *   - Unauthenticated requests get 401 + WWW-Authenticate: Bearer
 *     resource_metadata="…", which is what makes an MCP client open the
 *     browser consent flow on its own — the connector dialog needs nothing
 *     but the /mcp URL.
 *
 * Headless fallbacks: AGENT_API_KEY as X-Agent-Key/Bearer still works for
 * scripts (and the in-process CLI loopback uses a per-boot internal key);
 * writes on that path act on AGENT_USER_EMAIL, same as /api/ext/v1.
 *
 * Hosting: FastMCP owns its own HTTP listener (mcp-proxy binds the port), so
 * it runs on loopback and this module's Express router reverse-proxies /mcp
 * and the well-known documents to it. That keeps one public origin — MCP
 * clients, the web app, and the REST API all share the server's port.
 *
 * Tool executors are shared with the in-app agent and the ext REST API
 * (agent/context.ts), so all three surfaces stay in lockstep.
 */
import http from "node:http";
import { FastMCP, UserError } from "fastmcp";
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import {
  anyLngLat,
  boundAgentUser,
  buildCtx,
  getEta,
  getEvent,
  INTEREST_TOPICS,
  interestPatchEmpty,
  mergeInterests,
  parseInterestPatch,
  RARITIES,
  searchEvents,
  searchShape,
  setEventRarity,
  type SearchParams,
} from "./agent/context.js";
import { INTERNAL_MCP_KEY, ISSUER, userFromClaims, verifySupabaseToken } from "./auth.js";
import { safeEqual } from "./secrets.js";
import { removeEventForUser, saveEventForUser } from "./calendar.js";
import { clampCadence, runDiscovery, validQuery, wantsCommit } from "./discovery.js";
import { store } from "./store.js";
import { CATEGORIES, type User } from "./types.js";

export const SERVER_INFO = { name: "grapevine", version: "0.1.0" } as const;

/** What `authenticate` hands to every tool call. */
interface McpAuth extends Record<string, unknown> {
  /** The signed-in Grapevine account, when the caller came through OAuth. */
  user: User | null;
  via: "oauth" | "key" | "open";
}

// ---------------------------------------------------------------------------
// Tool schemas — Zod, so FastMCP validates arguments before `execute` runs and
// publishes the JSON Schema clients see in tools/list.
// ---------------------------------------------------------------------------

const lngLat = z
  .union([z.tuple([z.number(), z.number()]), z.string()])
  .describe('[lng, lat] array or "lng,lat" string');

const SCHEMAS = {
  search_events: z.object({
    query: z.string().optional().describe("free-text match on title/description/venue/tags"),
    // Derived from the shared registry — never a hand-copied list.
    categories: z.array(z.enum(CATEGORIES)).optional(),
    tags: z.array(z.string()).optional(),
    date_from: z.string().optional().describe("YYYY-MM-DD (city-local)"),
    date_to: z.string().optional().describe("YYYY-MM-DD (city-local)"),
    free_only: z.boolean().optional(),
    min_rating: z.number().optional().describe("1-5 buzz floor"),
    exclude_promoted: z.boolean().optional().describe("default true — hides paid placements"),
    near: z.string().optional().describe('place name or "lng,lat" to sort/filter by distance'),
    max_km: z.number().optional(),
    sort: z.enum(["time", "buzz", "distance"]).optional(),
    limit: z.number().optional().describe("1-20, default 8"),
  }),
  get_event: z.object({ id: z.string() }),
  get_eta: z.object({
    to_event_id: z.string().optional(),
    to: lngLat.optional().describe("alternative to to_event_id"),
    from: lngLat.optional().describe("origin (default: city center)"),
  }),
  list_saved_events: z.object({}),
  save_event: z.object({ event_id: z.string() }),
  unsave_event: z.object({ event_id: z.string() }),
  set_event_rarity: z.object({
    event_id: z.string(),
    rarity: z.enum(RARITIES),
  }),
  discover_events: z.object({
    query: z
      .string()
      .describe('what to look for, e.g. "jazz shows this weekend" (the city is appended automatically)'),
    dry_run: z
      .boolean()
      .optional()
      .describe("default true — verify and report without writing; false commits verified events"),
  }),
  list_scheduled_searches: z.object({}),
  schedule_search: z.object({
    query: z.string().describe("3-200 chars"),
    cadence_hours: z.number().optional().describe("hours between runs, 1-336 (default 24; 168 = weekly)"),
  }),
  unschedule_search: z.object({
    id: z.string().optional(),
    query: z.string().optional().describe("alternative to id — exact query text, case-insensitive"),
  }),
  // Same argument names as the in-app tool; the legacy camelCase spellings
  // (addLoves, …) are still accepted by parseInterestPatch.
  update_interests: z.object({
    add_loves: z.array(z.string()).optional(),
    add_avoids: z.array(z.string()).optional(),
    remove_loves: z.array(z.string()).optional(),
    remove_avoids: z.array(z.string()).optional(),
  }),
} as const;

type ToolName = keyof typeof SCHEMAS;

interface ToolSpec {
  name: ToolName;
  description: string;
  /** MCP tool annotations — read-only tools are safe to call unprompted. */
  readOnly?: boolean;
}

const TOOLS: ToolSpec[] = [
  {
    name: "search_events",
    readOnly: true,
    description:
      "Search upcoming local events (community-sourced, next occurrence per event). Returns id, title, venue, time, price, buzz rating. Use the returned ids with the other tools.",
  },
  {
    name: "get_event",
    readOnly: true,
    description:
      "Full detail for one event: description, address, ticket link, rating rationale, coordinates.",
  },
  {
    name: "get_eta",
    readOnly: true,
    description: "Driving ETA to an event (or coordinates), defaulting from the city center.",
  },
  {
    name: "list_saved_events",
    readOnly: true,
    description: "Events on the linked Grapevine account's calendar.",
  },
  {
    name: "save_event",
    description:
      "Save an event to the linked account's calendar (syncs to Google Calendar when connected).",
  },
  {
    name: "unsave_event",
    description: "Remove an event from the linked account's calendar.",
  },
  {
    name: "set_event_rarity",
    description:
      "Set an event's rarity in the database (applies immediately). rare = one-off or annual specials (parades, fireworks, races, big festivals); notable = uncommon but repeats; common = weekly/regular. Rarity drives the app's Rare finds filter.",
  },
  {
    name: "discover_events",
    description:
      "Search the open web for local events and add verified ones to the catalog. Each candidate is verified against the page it came from (dates, venue, a supporting quote) before anything is written; unverified candidates are reported with the rejection reason. Defaults to a dry run — call again with dry_run:false to commit, ideally after the user confirms.",
  },
  {
    name: "list_scheduled_searches",
    readOnly: true,
    description:
      "Saved web-discovery searches the server re-runs automatically, with cadence, last run time, and last result summary.",
  },
  {
    name: "schedule_search",
    description:
      "Save a web-discovery search the server re-runs on a schedule (verified events land on the map automatically). Re-saving an existing query updates its cadence.",
  },
  {
    name: "unschedule_search",
    description:
      "Delete a scheduled web-discovery search by id (from list_scheduled_searches) or exact query text.",
  },
  {
    name: "update_interests",
    description: `Tune the linked account's taste profile — writes immediately, so only call it after the user explicitly confirmed the change. Allowed topics: ${INTEREST_TOPICS.join(", ")}.`,
  },
];

function ok(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}

/** Tool-level failure the model should see and can recover from. */
function fail(message: string): never {
  throw new UserError(message);
}

/**
 * The account MCP writes act on. OAuth callers carry their own user (from the
 * verified token); key-authed and open-mode callers fall back to the account
 * named by AGENT_USER_EMAIL, same as /api/ext/v1.
 */
async function boundUser(oauthUser: User | null): Promise<User> {
  if (oauthUser) return oauthUser;
  const bound = await boundAgentUser();
  if ("error" in bound) fail(bound.error);
  return bound;
}

async function callTool(name: ToolName, args: Record<string, any>, oauthUser: User | null) {
  const ctx = await buildCtx();
  switch (name) {
    case "search_events": {
      const result = await searchEvents(
        {
          query: args.query,
          categories: args.categories,
          tags: args.tags,
          date_from: args.date_from,
          date_to: args.date_to,
          free_only: args.free_only,
          min_rating: args.min_rating,
          exclude_promoted: args.exclude_promoted,
          near: args.near,
          max_km: args.max_km,
          sort: args.sort as SearchParams["sort"],
          limit: args.limit,
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
      // Same payload the in-app tool takes ([lng,lat]); "lng,lat" strings
      // stay accepted for existing clients.
      const result = await getEta(
        {
          to_event_id: args.to_event_id,
          to: anyLngLat(args.to),
          from: anyLngLat(args.from),
        },
        ctx,
      );
      return "error" in result ? fail(String(result.error)) : ok(result);
    }
    case "list_saved_events": {
      const user = await boundUser(oauthUser);
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
      const query = validQuery(args.query);
      if (!query) return fail("query must be 3-200 chars");
      const result = await runDiscovery({ query, commit: wantsCommit(args) });
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
        dry_run: !wantsCommit(args),
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
      const query = validQuery(args.query);
      if (!query) return fail("query must be 3-200 chars");
      const saved = await store.addDiscoverySearch(query, clampCadence(args.cadence_hours));
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
      const patch = parseInterestPatch(args);
      if (interestPatchEmpty(patch))
        return fail(`no valid topics — allowed: ${INTEREST_TOPICS.join(", ")}`);
      const current = (user.prefs?.interests ?? {}) as { loves?: string[]; avoids?: string[] };
      const { loves, avoids } = mergeInterests(current, patch);
      const updated = await store.updateUserPrefs(user.id, { interests: { loves, avoids } });
      return ok({ interests: updated?.prefs?.interests ?? { loves, avoids } });
    }
  }
}

// ---------------------------------------------------------------------------
// Public identity — where MCP clients reach us
// ---------------------------------------------------------------------------

/** "oauth" unless MCP_OPEN=1 restores the old unauthenticated behavior. */
export function mcpAuthMode(): "oauth" | "open" {
  return process.env.MCP_OPEN === "1" ? "open" : "oauth";
}

/**
 * The public origin MCP clients connect to. Unlike the old per-request
 * derivation, OAuth needs one stable value: the resource identifier a client
 * validates and sends as RFC 8707 `resource`. Set MCP_PUBLIC_URL whenever the
 * server sits behind a tunnel or reverse proxy.
 */
function publicBase(): string {
  const base = process.env.MCP_PUBLIC_URL ?? `http://localhost:${process.env.PORT ?? 8787}`;
  return base.replace(/\/$/, "");
}

const RESOURCE_METADATA_PATH = "/.well-known/oauth-protected-resource";
const AS_METADATA_PATH = "/.well-known/oauth-authorization-server";
const MCP_ENDPOINT = "/mcp";

/** Loopback port FastMCP's own HTTP server binds; Express proxies to it. */
function internalPort(): number {
  const explicit = Number(process.env.MCP_INTERNAL_PORT);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  return Number(process.env.PORT ?? 8787) + 1;
}

const INTERNAL_HOST = "127.0.0.1";

// ---------------------------------------------------------------------------
// Auth — Supabase JWT first, shared agent key second
// ---------------------------------------------------------------------------

/**
 * OAuth 2.1 resource auth. Order matters: a Bearer value is first tried as a
 * Supabase JWT (per-user), then as the shared agent key (headless scripts).
 * Returning undefined makes FastMCP answer 401 with the RFC 9728 challenge
 * that kicks MCP clients into the browser consent flow.
 */
async function authenticate(req: http.IncomingMessage): Promise<McpAuth | undefined> {
  const header = req.headers.authorization ?? "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7) : undefined;
  if (bearer) {
    const user = await userFromClaims(await verifySupabaseToken(bearer));
    if (user) return { user, via: "oauth" };
  }
  const agentKey = req.headers["x-agent-key"];
  const given = (Array.isArray(agentKey) ? agentKey[0] : agentKey) ?? bearer;
  const key = process.env.AGENT_API_KEY;
  if (safeEqual(given, key) || safeEqual(given, INTERNAL_MCP_KEY)) {
    return { user: null, via: "key" };
  }
  if (mcpAuthMode() === "open") return { user: null, via: "open" }; // explicit MCP_OPEN=1 opt-in
  return undefined;
}

// ---------------------------------------------------------------------------
// Authorization-server metadata (Supabase), read once at boot
// ---------------------------------------------------------------------------

interface RawAsDoc {
  issuer?: string;
  authorization_endpoint?: string;
  token_endpoint?: string;
  registration_endpoint?: string;
  revocation_endpoint?: string;
  jwks_uri?: string;
  response_types_supported?: string[];
  grant_types_supported?: string[];
  code_challenge_methods_supported?: string[];
  scopes_supported?: string[];
  token_endpoint_auth_methods_supported?: string[];
}

/**
 * Supabase's own RFC 8414 document. Fetched once at boot so the endpoints we
 * advertise are exactly the ones the authorization server publishes; the
 * fallbacks below keep discovery working if that fetch fails (offline dev).
 */
async function authorizationServerConfig() {
  let doc: RawAsDoc = {};
  try {
    const url = ISSUER.replace("/auth/v1", `${AS_METADATA_PATH}/auth/v1`);
    const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (r.ok) doc = (await r.json()) as RawAsDoc;
  } catch (err) {
    console.warn(`[mcp] authorization server metadata unavailable: ${String(err).slice(0, 120)}`);
  }
  return {
    issuer: doc.issuer ?? ISSUER,
    authorizationEndpoint: doc.authorization_endpoint ?? `${ISSUER}/authorize`,
    tokenEndpoint: doc.token_endpoint ?? `${ISSUER}/token`,
    ...(doc.registration_endpoint && { registrationEndpoint: doc.registration_endpoint }),
    ...(doc.revocation_endpoint && { revocationEndpoint: doc.revocation_endpoint }),
    jwksUri: doc.jwks_uri ?? `${ISSUER}/.well-known/jwks.json`,
    responseTypesSupported: doc.response_types_supported ?? ["code"],
    grantTypesSupported: doc.grant_types_supported ?? ["authorization_code", "refresh_token"],
    codeChallengeMethodsSupported: doc.code_challenge_methods_supported ?? ["S256"],
    scopesSupported: doc.scopes_supported ?? ["openid", "email", "profile"],
    tokenEndpointAuthMethodsSupported: doc.token_endpoint_auth_methods_supported ?? ["none"],
  };
}

// ---------------------------------------------------------------------------
// Server construction + lifecycle
// ---------------------------------------------------------------------------

function buildServer(oauth: {
  authorizationServer: Awaited<ReturnType<typeof authorizationServerConfig>>;
}): FastMCP<McpAuth | undefined> {
  const server = new FastMCP<McpAuth | undefined>({
    name: SERVER_INFO.name,
    version: SERVER_INFO.version,
    instructions:
      "Grapevine is a live map of local events. Search first, then use the returned ids for detail, travel time, and calendar saves. Writes act on the account the caller signed in with.",
    authenticate,
    oauth: {
      enabled: true,
      authorizationServer: oauth.authorizationServer,
      protectedResource: {
        resource: `${publicBase()}${MCP_ENDPOINT}`,
        authorizationServers: [ISSUER],
        bearerMethodsSupported: ["header"],
        resourceName: "Grapevine",
        scopesSupported: ["openid", "email", "profile"],
      },
    },
  });

  for (const spec of TOOLS) {
    server.addTool({
      name: spec.name,
      description: spec.description,
      annotations: {
        title: spec.name.replace(/_/g, " "),
        readOnlyHint: spec.readOnly ?? false,
        openWorldHint: spec.name === "discover_events",
      },
      parameters: SCHEMAS[spec.name],
      execute: (args, { session }) =>
        callTool(spec.name, args as Record<string, any>, session?.user ?? null),
    });
  }
  return server;
}

let server: FastMCP<McpAuth | undefined> | null = null;

/**
 * Boots FastMCP's HTTP listener on loopback. Called once from index.ts after
 * the Express app is listening; the router below proxies to it.
 */
export async function startMcpServer(): Promise<void> {
  if (server) return;
  const authorizationServer = await authorizationServerConfig();
  server = buildServer({ authorizationServer });
  await server.start({
    transportType: "httpStream",
    httpStream: {
      host: INTERNAL_HOST,
      port: internalPort(),
      endpoint: MCP_ENDPOINT,
      // Stateless + JSON responses: no SSE stream to keep alive, no session
      // table to survive restarts. Concurrent clients can't collide.
      stateless: true,
      enableJsonResponse: true,
      // CORS for browser-based MCP clients (the MCP inspector, web apps).
      // Claude's own connector calls server-to-server and ignores this; the
      // wildcard origin grants nothing by itself since auth rides on every
      // request.
      cors: {
        origin: "*",
        methods: ["POST", "GET", "DELETE", "OPTIONS"],
        allowedHeaders: [
          "Content-Type",
          "Authorization",
          "X-Agent-Key",
          "Mcp-Session-Id",
          "Mcp-Protocol-Version",
          "Last-Event-ID",
        ],
        exposedHeaders: ["Mcp-Session-Id", "Mcp-Protocol-Version", "WWW-Authenticate"],
      },
    },
  });
  console.log(
    `[grapevine] mcp (fastmcp) on ${publicBase()}${MCP_ENDPOINT} — auth: ${mcpAuthMode()}`,
  );
}

// ---------------------------------------------------------------------------
// Express front door — one public origin, forwarded to the FastMCP listener
// ---------------------------------------------------------------------------

/** Headers that describe the hop, not the message. */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/** Pipe one request through to FastMCP, streaming the response back. */
function forward(req: Request, res: Response, path: string) {
  const port = internalPort();
  const headers: Record<string, string | string[]> = {
    ...(req.headers as Record<string, string | string[]>),
    host: `${INTERNAL_HOST}:${port}`,
  };
  for (const name of HOP_BY_HOP) delete headers[name];

  const upstream = http.request(
    { host: INTERNAL_HOST, port, method: req.method, path, headers },
    (up) => {
      res.status(up.statusCode ?? 502);
      for (const [name, value] of Object.entries(up.headers)) {
        if (value !== undefined && !HOP_BY_HOP.has(name)) res.setHeader(name, value);
      }
      if (!res.getHeader("access-control-allow-origin")) {
        res.setHeader("Access-Control-Allow-Origin", "*");
      }
      up.pipe(res);
    },
  );
  upstream.on("error", (err) => {
    if (res.headersSent) return res.end();
    res.status(503).json({
      jsonrpc: "2.0",
      error: { code: -32603, message: `mcp server unavailable: ${String(err).slice(0, 160)}` },
      id: null,
    });
  });
  // A client that hangs up must not leave a tool call running upstream.
  res.on("close", () => upstream.destroy());
  req.pipe(upstream);
}

export const mcp = Router();

// The MCP endpoint itself. index.ts leaves this path unparsed so the JSON-RPC
// body streams straight through.
mcp.all(MCP_ENDPOINT, (req, res) => forward(req, res, req.originalUrl));

/**
 * Discovery documents, served by FastMCP:
 *   - RFC 9728 protected-resource metadata at the bare path and the
 *     /mcp-suffixed variant clients derive from the resource URL's path.
 *   - The /mcp/-prefixed alias: mcp-proxy builds its 401 challenge by
 *     appending the well-known path to the resource identifier, so the
 *     challenge points at <origin>/mcp/.well-known/oauth-protected-resource.
 *     Mapping it back keeps the canonical resource id *and* a URL that
 *     resolves for every client.
 *   - RFC 8414 authorization-server metadata, a compatibility shim for
 *     pre-2025-06-18 clients that fetch it straight from the MCP origin.
 */
mcp.get(`${MCP_ENDPOINT}${RESOURCE_METADATA_PATH}`, (req, res) =>
  forward(req, res, `${RESOURCE_METADATA_PATH}${MCP_ENDPOINT}`),
);
mcp.get([RESOURCE_METADATA_PATH, `${RESOURCE_METADATA_PATH}${MCP_ENDPOINT}`, AS_METADATA_PATH], (req, res) =>
  forward(req, res, req.originalUrl),
);
