/**
 * Supabase Auth — the browser signs in with supabase-js (Google/GitHub via
 * the PKCE authorization-code flow) and sends its access token on every API
 * call as `Authorization: Bearer <jwt>`.
 *
 * This project uses asymmetric JWT signing keys (ES256), so the server
 * verifies tokens locally against the project's JWKS — no auth-server round
 * trip per request. The profile row in public.users is created/refreshed by
 * a DB trigger on auth.users; sessionUser falls back to a JIT upsert from
 * the verified claims so a trigger race can never 401 a valid user.
 */
import { randomBytes } from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { Router, type NextFunction, type Request, type Response } from "express";
import { isAdminUser } from "./admin-gate.js";
import { store } from "./store.js";
import type { User } from "./types.js";

/**
 * Per-boot secret for in-process loopback calls (providers.ts points a CLI's
 * MCP config back at this same server's /mcp). Never leaves the process, so
 * the loopback works even with no AGENT_API_KEY configured. Lives here rather
 * than mcp.ts to keep providers.ts → mcp.ts → llm.ts → providers.ts acyclic.
 */
export const INTERNAL_MCP_KEY = randomBytes(32).toString("hex");

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

const SUPABASE_URL = env("SUPABASE_URL").replace(/\/$/, "");
/** Also the OAuth 2.1 authorization-server identity MCP clients discover. */
export const ISSUER = `${SUPABASE_URL}/auth/v1`;

// jose caches the key set and refetches on unknown-kid, so key rotation in
// the Supabase dashboard just works.
const JWKS = createRemoteJWKSet(new URL(`${ISSUER}/.well-known/jwks.json`));

export interface SupabaseClaims {
  sub?: string;
  email?: string;
  role?: string;
  user_metadata?: {
    name?: string;
    full_name?: string;
    avatar_url?: string;
    picture?: string;
  };
}

/**
 * Verifies a Supabase-issued JWT against the project JWKS; returns its claims
 * or null (never throws). Covers both browser session tokens and access
 * tokens minted by Supabase's OAuth 2.1 server (MCP clients) — same issuer,
 * same keys. No audience constraint here: OAuth tokens can carry a custom
 * `aud`, so the real gate is the `role === "authenticated"` check that every
 * caller applies via userFromClaims.
 */
export async function verifySupabaseToken(token: string): Promise<SupabaseClaims | null> {
  try {
    const { payload } = await jwtVerify(token, JWKS, { issuer: ISSUER });
    return payload as SupabaseClaims;
  } catch {
    return null; // expired, forged, or not ours — treated as signed out
  }
}

/** Verified claims → Grapevine user, or null for anon/malformed tokens. */
export async function userFromClaims(claims: SupabaseClaims | null): Promise<User | null> {
  if (!claims?.sub || claims.role !== "authenticated") return null;
  const user = await store.userById(claims.sub);
  if (user) return user;
  // The DB trigger creates profiles on signup; this only runs if a request
  // races that trigger. Idempotent, keyed on the verified auth uid.
  const meta = claims.user_metadata ?? {};
  return store.upsertProfile({
    id: claims.sub,
    email: claims.email ?? "",
    name: meta.name ?? meta.full_name ?? claims.email ?? "",
    picture: meta.avatar_url ?? meta.picture ?? "",
  });
}

/**
 * Resolves the signed-in user from the Authorization header, if any.
 * Same signature the cookie-session version had, so every route keeps
 * calling it unchanged.
 */
export async function sessionUser(req: Request): Promise<User | null> {
  const header = req.headers.authorization ?? "";
  if (!header.startsWith("Bearer ")) return null;
  return userFromClaims(await verifySupabaseToken(header.slice(7)));
}

/** May the caller use the admin surface. The policy lives in admin-gate.ts. */
export async function adminAllowed(req: Request): Promise<boolean> {
  return isAdminUser(await sessionUser(req).catch(() => null));
}

/** The same check as middleware, so a whole route is gated in one word. */
export async function requireAdmin(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (await adminAllowed(req)) return next();
  res.status(403).json({ error: "admin only" });
}

// ---------- routes ----------

export const auth = Router();

auth.get("/api/me", async (req, res) => {
  const user = await sessionUser(req);
  // isAdmin decides whether the Admin button renders at all. The routes behind
  // it check again, so this is a courtesy to the UI, not the gate.
  res.json({ user: user ? publicUser(user) : null, isAdmin: isAdminUser(user) });
});

auth.put("/api/me/prefs", async (req, res) => {
  const user = await sessionUser(req);
  if (!user) return res.status(401).json({ error: "not signed in" });
  const { filters, interests, pinnedIds, hiddenIds, mutedVenues, mutedSources } =
    req.body ?? {};
  const updated = await store.updateUserPrefs(user.id, {
    ...(filters !== undefined && { filters }),
    ...(interests !== undefined && { interests }),
    ...(pinnedIds !== undefined && { pinnedIds }),
    ...(hiddenIds !== undefined && { hiddenIds }),
    ...(mutedVenues !== undefined && { mutedVenues }),
    ...(mutedSources !== undefined && { mutedSources }),
  });
  res.json({ user: updated ? publicUser(updated) : null });
});

/** Strip internal fields before sending a user to the browser. */
function publicUser(u: User) {
  const { googleCalendar: _googleCalendar, feedToken: _feedToken, ...rest } = u;
  return rest;
}
