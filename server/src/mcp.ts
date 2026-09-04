/**
 * Grapevine as an MCP server: lets Claude (Claude Code, Claude Desktop, or
 * any MCP client) drive this app's tools directly. Search events, look up
 * details and ETAs, save to the calendar, tune interests, and run verified
 * web discovery, including managing its scheduled searches.
 *
 * The tools are the "mcp" surface of agent/contracts.ts: names, descriptions,
 * schemas and annotations all come from there, and the executors are the
 * same functions the in-app agent and the REST API call (agent/context.ts),
 * so the three surfaces cannot drift apart.
 *
 * Built on FastMCP 4: tool schemas are Zod (validated before `execute` runs),
 * and the OAuth 2.1 resource layer (RFC 8414 + RFC 9728 discovery documents
 * and the 401 `WWW-Authenticate` challenge) is FastMCP's, not hand-rolled.
 *
 * Transport: Streamable HTTP at POST /mcp, stateless (a fresh session per
 * request: no session bookkeeping, works across server restarts).
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
 *     browser consent flow on its own; the connector dialog needs nothing but
 *     the /mcp URL.
 *
 * Headless fallbacks: AGENT_API_KEY as X-Agent-Key/Bearer still works for
 * scripts (and the in-process CLI loopback uses a per-boot internal key);
 * writes on that path act on AGENT_USER_EMAIL, same as /api/ext/v1.
 *
 * Hosting: FastMCP owns its own HTTP listener (mcp-proxy binds the port), so
 * it runs on loopback and mcp-proxy.ts reverse-proxies /mcp and the
 * well-known documents to it. That keeps one public origin: MCP clients, the
 * web app, and the REST API all share the server's port.
 */
import type http from "node:http";
import { FastMCP, UserError } from "fastmcp";
import { INTERNAL_MCP_KEY, ISSUER, userFromClaims, verifySupabaseToken } from "./auth.js";
import { logger } from "./log.js";
import {
  applyInterests,
  anyLngLat,
  boundAgentUser,
  buildCtx,
  getEta,
  getEvent,
  interestsPreview,
  parseInterestPatch,
  savedEvents,
  searchEvents,
  setEventRarity,
} from "./agent/context.js";
import { toolsFor, type ToolArgs, type ToolsOn } from "./agent/contracts.js";
import { removeEventForUser, saveEventForUser } from "./calendar.js";
import { clampCadence, runDiscovery, runSavedSearch } from "./discovery.js";
import { safeEqual } from "./secrets.js";
import { store } from "./store.js";
import type { User } from "./types.js";
import { apiOrigin } from "./urls.js";
import { VERSION } from "./version.js";

/** Same version /version reports; the MCP handshake used to say 0.1.0 forever. */
export const SERVER_INFO = {
  name: VERSION.name,
  // FastMCP types the version as a semver template; package.json's is one.
  version: VERSION.version as `${number}.${number}.${number}`,
} as const;

const log = logger("mcp");

/** What `authenticate` hands to every tool call. */
interface McpAuth extends Record<string, unknown> {
  /** The signed-in Grapevine account, when the caller came through OAuth. */
  user: User | null;
  via: "oauth" | "key" | "open";
}

type McpTool = ToolsOn<"mcp">;

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

/** The executor behind each MCP tool. Arguments arrive already validated by the contract schema. */
async function callTool<N extends McpTool>(name: N, args: ToolArgs<N>, oauthUser: User | null) {
  const ctx = await buildCtx();
  switch (name) {
    case "search_events": {
      const result = await searchEvents(args as ToolArgs<"search_events">, ctx);
      return ok({ city: ctx.settings.city, tz: ctx.settings.tz, ...result });
    }
    case "get_event": {
      const result = getEvent((args as ToolArgs<"get_event">).id, ctx);
      return "error" in result ? fail(String(result.error)) : ok(result);
    }
    case "get_eta": {
      const a = args as ToolArgs<"get_eta">;
      const result = await getEta(
        { to_event_id: a.to_event_id, to: anyLngLat(a.to), from: anyLngLat(a.from) },
        ctx,
      );
      return "error" in result ? fail(String(result.error)) : ok(result);
    }
    case "list_saved_events": {
      const user = await boundUser(oauthUser);
      return ok(await savedEvents(user, ctx));
    }
    case "save_event":
    case "unsave_event": {
      const user = await boundUser(oauthUser);
      const id = (args as ToolArgs<"save_event">).event_id;
      const result =
        name === "save_event"
          ? await saveEventForUser(user, id)
          : await removeEventForUser(user, id);
      return "error" in result ? fail(result.error) : ok(result);
    }
    case "set_rarity": {
      const a = args as ToolArgs<"set_rarity">;
      const result = await setEventRarity(a.event_id, a.rarity, ctx);
      if ("error" in result) return fail(result.error);
      return ok({
        id: result.event.id,
        title: result.event.title,
        rarity: result.event.rarity,
        changed: result.changed,
      });
    }
    case "discover_events": {
      const a = args as ToolArgs<"discover_events">;
      const commit = a.dry_run === false;
      const result = await runDiscovery({ query: a.query, commit });
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
        dry_run: !commit,
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
      const a = args as ToolArgs<"schedule_search">;
      const saved = await store.addDiscoverySearch(a.query, clampCadence(a.cadence_hours));
      return ok({ scheduled: true, ...saved });
    }
    case "update_scheduled_search": {
      const a = args as ToolArgs<"update_scheduled_search">;
      if (a.active === undefined && a.cadence_hours === undefined) {
        return fail("nothing to update: give active and/or cadence_hours");
      }
      const updated = await store.updateDiscoverySearch(a.id, {
        ...(a.active !== undefined && { active: a.active }),
        ...(a.cadence_hours !== undefined && { cadenceHours: clampCadence(a.cadence_hours) }),
      });
      return updated ? ok(updated) : fail("unknown scheduled search");
    }
    case "run_scheduled_search": {
      const a = args as ToolArgs<"run_scheduled_search">;
      const search = await store.discoverySearchById(a.id);
      if (!search) return fail("unknown scheduled search");
      return ok(await runSavedSearch(search));
    }
    case "unschedule_search": {
      const a = args as ToolArgs<"unschedule_search">;
      let id = a.id ?? "";
      if (!id && a.query) {
        const q = a.query.trim().toLowerCase();
        id = (await store.discoverySearches()).find((s) => s.query.toLowerCase() === q)?.id ?? "";
      }
      if (!id) return fail("give id or the exact query of a scheduled search");
      const deleted = await store.deleteDiscoverySearch(id);
      return deleted ? ok({ deleted: true, id }) : fail("unknown scheduled search");
    }
    case "update_interests": {
      // Proposes only, like the in-app tool. The client shows the proposal
      // and calls apply_interests with confirmed:true once the user agrees.
      const user = await boundUser(oauthUser);
      const preview = await interestsPreview(user, parseInterestPatch(args as Record<string, unknown>));
      if ("error" in preview) return fail(preview.error);
      return ok({
        ...preview,
        confirmed: false,
        note: "Nothing written. Show this to the user; call apply_interests with the same arguments and confirmed:true once they agree.",
      });
    }
    case "apply_interests": {
      const user = await boundUser(oauthUser);
      const result = await applyInterests(user, parseInterestPatch(args as Record<string, unknown>));
      if ("error" in result) return fail(result.error);
      return ok({ ...result, confirmed: true });
    }
  }
}

// ---------------------------------------------------------------------------
// Public identity: where MCP clients reach us
// ---------------------------------------------------------------------------

/** "oauth" unless MCP_OPEN=1 restores the old unauthenticated behavior. */
export function mcpAuthMode(): "oauth" | "open" {
  return process.env.MCP_OPEN === "1" ? "open" : "oauth";
}

export const RESOURCE_METADATA_PATH = "/.well-known/oauth-protected-resource";
export const AS_METADATA_PATH = "/.well-known/oauth-authorization-server";
export const MCP_ENDPOINT = "/mcp";

/** Loopback port FastMCP's own HTTP server binds; mcp-proxy.ts forwards to it. */
export function internalPort(): number {
  const explicit = Number(process.env.MCP_INTERNAL_PORT);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  return Number(process.env.PORT ?? 8787) + 1;
}

export const INTERNAL_HOST = "127.0.0.1";

// ---------------------------------------------------------------------------
// Auth: Supabase JWT first, shared agent key second
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
  if (safeEqual(given, process.env.AGENT_API_KEY) || safeEqual(given, INTERNAL_MCP_KEY)) {
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
    log.warn({ err: String(err).slice(0, 120) }, "authorization server metadata unavailable");
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
      "Grapevine is a live map of local events. Search first, then use the returned ids for detail, travel time, and calendar saves. Writes act on the account the caller signed in with; update_interests only proposes, apply_interests with confirmed:true writes.",
    authenticate,
    oauth: {
      enabled: true,
      authorizationServer: oauth.authorizationServer,
      protectedResource: {
        resource: `${apiOrigin()}${MCP_ENDPOINT}`,
        authorizationServers: [ISSUER],
        bearerMethodsSupported: ["header"],
        resourceName: "Grapevine",
        scopesSupported: ["openid", "email", "profile"],
      },
    },
  });

  for (const spec of toolsFor("mcp")) {
    server.addTool({
      name: spec.name,
      description: spec.description,
      annotations: {
        title: spec.name.replace(/_/g, " "),
        readOnlyHint: spec.effect === "read",
        openWorldHint: spec.openWorld ?? false,
      },
      parameters: spec.schema,
      execute: (args, { session }) =>
        callTool(spec.name as McpTool, args as never, session?.user ?? null),
    });
  }
  return server;
}

let server: FastMCP<McpAuth | undefined> | null = null;

/**
 * Boots FastMCP's HTTP listener on loopback. Called once from index.ts after
 * the Express app is listening; mcp-proxy.ts forwards to it.
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
  log.info(`mcp (fastmcp) on ${apiOrigin()}${MCP_ENDPOINT}, auth: ${mcpAuthMode()}`);
}

/** Close the loopback listener; the shutdown hook calls this. */
export async function stopMcpServer(): Promise<void> {
  const running = server;
  server = null;
  await running?.stop();
}
