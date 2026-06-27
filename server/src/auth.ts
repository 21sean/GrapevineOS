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
import { createRemoteJWKSet, jwtVerify } from "jose";
import { Router, type Request } from "express";
import { store } from "./store.js";
import type { User } from "./types.js";

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

const SUPABASE_URL = env("SUPABASE_URL").replace(/\/$/, "");
const ISSUER = `${SUPABASE_URL}/auth/v1`;

// jose caches the key set and refetches on unknown-kid, so key rotation in
// the Supabase dashboard just works.
const JWKS = createRemoteJWKSet(new URL(`${ISSUER}/.well-known/jwks.json`));

interface SupabaseClaims {
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

/** Verifies the Bearer token; returns its claims or null (never throws). */
async function verifyToken(req: Request): Promise<SupabaseClaims | null> {
  const header = req.headers.authorization ?? "";
  if (!header.startsWith("Bearer ")) return null;
  const token = header.slice(7);
  try {
    const { payload } = await jwtVerify(token, JWKS, {
      issuer: ISSUER,
      audience: "authenticated",
    });
    return payload as SupabaseClaims;
  } catch {
    return null; // expired, forged, or not ours — treated as signed out
  }
}

/**
 * Resolves the signed-in user from the Authorization header, if any.
 * Same signature the cookie-session version had, so every route keeps
 * calling it unchanged.
 */
export async function sessionUser(req: Request): Promise<User | null> {
  const claims = await verifyToken(req);
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

// ---------- routes ----------

export const auth = Router();

auth.get("/api/me", async (req, res) => {
  const user = await sessionUser(req);
  res.json({ user: user ? publicUser(user) : null });
});

auth.put("/api/me/prefs", async (req, res) => {
  const user = await sessionUser(req);
  if (!user) return res.status(401).json({ error: "not signed in" });
  const { filters, interests, pinnedIds, hiddenIds } = req.body ?? {};
  const updated = await store.updateUserPrefs(user.id, {
    ...(filters !== undefined && { filters }),
    ...(interests !== undefined && { interests }),
    ...(pinnedIds !== undefined && { pinnedIds }),
    ...(hiddenIds !== undefined && { hiddenIds }),
  });
  res.json({ user: updated ? publicUser(updated) : null });
});

/** Strip internal fields before sending a user to the browser. */
function publicUser(u: User) {
  const { googleCalendar: _googleCalendar, feedToken: _feedToken, ...rest } = u;
  return rest;
}
