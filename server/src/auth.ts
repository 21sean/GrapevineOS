/**
 * Google Sign-In via the OAuth 2.0 authorization-code flow — no extra deps.
 *
 * The browser hits /auth/google (full-page redirect), Google sends the user
 * back to /auth/google/callback (proxied through Vite in dev, so the cookie
 * origin matches the app), and we exchange the code server-side using the
 * client secret from .env. Sessions persist to data/sessions.json so
 * `tsx watch` restarts don't sign anyone out.
 */
import crypto from "node:crypto";
import { Router, type Request, type Response } from "express";
import { store } from "./store.js";
import type { User } from "./types.js";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

const STATE_COOKIE = "gv_oauth_state";
const SESSION_COOKIE = "gv_session";
const STATE_TTL_MS = 10 * 60 * 1000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

function redirectUri(): string {
  // Must match a redirect URI registered on the Google OAuth client.
  return process.env.GOOGLE_REDIRECT_URI ?? "http://localhost:5174/auth/google/callback";
}

// ---------- cookies (tiny helpers; not worth a dependency) ----------

function cookies(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function setCookie(res: Response, name: string, value: string, maxAgeMs: number) {
  res.append(
    "Set-Cookie",
    `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(maxAgeMs / 1000)}`,
  );
}

function clearCookie(res: Response, name: string) {
  setCookie(res, name, "", 0);
}

/** Resolves the signed-in user from the session cookie, if any. */
export function sessionUser(req: Request): User | null {
  const token = cookies(req)[SESSION_COOKIE];
  return token ? store.sessionUser(token) : null;
}

// ---------- routes ----------

export const auth = Router();

auth.get("/auth/google", (_req, res) => {
  const state = crypto.randomBytes(16).toString("hex");
  setCookie(res, STATE_COOKIE, state, STATE_TTL_MS);
  const params = new URLSearchParams({
    client_id: env("GOOGLE_CLIENT_ID"),
    redirect_uri: redirectUri(),
    response_type: "code",
    scope: "openid email profile",
    state,
    prompt: "select_account",
  });
  res.redirect(`${GOOGLE_AUTH_URL}?${params}`);
});

auth.get("/auth/google/callback", async (req, res) => {
  const code = typeof req.query.code === "string" ? req.query.code : "";
  const state = typeof req.query.state === "string" ? req.query.state : "";
  const expected = cookies(req)[STATE_COOKIE];
  clearCookie(res, STATE_COOKIE);
  if (!code || !state || !expected || state !== expected) {
    return res.redirect("/?auth=failed");
  }
  try {
    const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: env("GOOGLE_CLIENT_ID"),
        client_secret: env("GOOGLE_CLIENT_SECRET"),
        redirect_uri: redirectUri(),
        grant_type: "authorization_code",
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!tokenRes.ok) throw new Error(`token exchange failed: ${await tokenRes.text()}`);
    const { id_token } = (await tokenRes.json()) as { id_token?: string };
    if (!id_token) throw new Error("no id_token in token response");

    // The id_token came straight from Google's token endpoint over TLS, so
    // per Google's docs the JWT signature doesn't need re-verification here.
    const claims = JSON.parse(Buffer.from(id_token.split(".")[1], "base64url").toString()) as {
      sub?: string;
      email?: string;
      name?: string;
      picture?: string;
    };
    if (!claims.sub) throw new Error("id_token missing sub claim");

    const user = store.upsertUser({
      googleId: claims.sub,
      email: claims.email ?? "",
      name: claims.name ?? claims.email ?? "Google user",
      picture: claims.picture ?? "",
    });
    setCookie(res, SESSION_COOKIE, store.createSession(user.id, SESSION_TTL_MS), SESSION_TTL_MS);
    res.redirect("/");
  } catch (err) {
    console.error("[auth] google callback:", err);
    res.redirect("/?auth=failed");
  }
});

auth.post("/auth/logout", (req, res) => {
  const token = cookies(req)[SESSION_COOKIE];
  if (token) store.deleteSession(token);
  clearCookie(res, SESSION_COOKIE);
  res.json({ ok: true });
});

auth.get("/api/me", (req, res) => {
  const user = sessionUser(req);
  res.json({ user: user ? publicUser(user) : null });
});

auth.put("/api/me/prefs", (req, res) => {
  const user = sessionUser(req);
  if (!user) return res.status(401).json({ error: "not signed in" });
  const { filters, interests } = req.body ?? {};
  const updated = store.updateUserPrefs(user.id, {
    ...(filters !== undefined && { filters }),
    ...(interests !== undefined && { interests }),
  });
  res.json({ user: updated ? publicUser(updated) : null });
});

/** Strip internal fields before sending a user to the browser. */
function publicUser(u: User) {
  const { googleId: _googleId, ...rest } = u;
  return rest;
}
