/**
 * Supabase Auth client — the ONLY thing the browser uses Supabase for.
 * Data still flows through the Express API (the DB keeps its deny-all RLS
 * posture); this client just runs the PKCE sign-in flows and holds the
 * session whose access token api.ts attaches to every request.
 *
 * Env (web/.env.local):
 *   VITE_SUPABASE_URL=https://<project-ref>.supabase.co
 *   VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_…   (safe in the browser)
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js"

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined

if (!url || !key) {
  console.warn(
    "[grapevine] VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY are not set — " +
      "sign-in is disabled. Copy web/.env.example to web/.env.local and fill them in.",
  )
}

/** Null when the env isn't configured — the map still works signed out. */
export const supabase: SupabaseClient | null =
  url && key
    ? createClient(url, key, {
        auth: {
          flowType: "pkce", // authorization-code + PKCE, the OAuth 2.1 standard
          detectSessionInUrl: true,
          persistSession: true,
          autoRefreshToken: true,
        },
      })
    : null

export type OAuthProvider = "google" | "github"

/** Full-page redirect into the provider's consent screen (PKCE flow). */
export async function signInWithProvider(provider: OAuthProvider): Promise<void> {
  if (!supabase) throw new Error("Sign-in isn't configured (missing Supabase env)")
  const { error } = await supabase.auth.signInWithOAuth({
    provider,
    options: { redirectTo: window.location.origin },
  })
  if (error) throw error
}

export const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.events"

/**
 * Incremental consent for Google Calendar: same PKCE flow, plus the
 * calendar scope and offline access so Google returns a refresh token.
 * The app lands back on /?calendar=oauth, grabs provider_refresh_token off
 * the fresh session, and hands it to the server (which vaults it).
 */
export async function connectGoogleCalendar(): Promise<void> {
  if (!supabase) throw new Error("Sign-in isn't configured (missing Supabase env)")
  const { error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: {
      redirectTo: `${window.location.origin}/?calendar=oauth`,
      scopes: CALENDAR_SCOPE,
      queryParams: {
        access_type: "offline",
        prompt: "consent", // forces a refresh token even on re-grants
        include_granted_scopes: "true",
      },
    },
  })
  if (error) throw error
}

/** Bearer token for the Express API, or null when signed out. */
export async function accessToken(): Promise<string | null> {
  if (!supabase) return null
  const { data } = await supabase.auth.getSession()
  return data.session?.access_token ?? null
}
