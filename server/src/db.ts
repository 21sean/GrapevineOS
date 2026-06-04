/**
 * Supabase client — the server's single connection to Postgres.
 *
 * supabase-js talks PostgREST over HTTPS (no raw Postgres connection), so
 * there is no pool to manage and it works from any network, which is exactly
 * what the free tier wants. The secret key bypasses RLS; it lives only in
 * server/.env and must never be sent to the browser.
 *
 * Queries chain .throwOnError(), so callers get typed data or an exception —
 * route handlers catch and translate to HTTP errors.
 */
import { createClient } from "@supabase/supabase-js";
import type { Database } from "./db-types.js";

function env(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(
      `${name} is not set — copy it from the Supabase dashboard ` +
        `(Settings → API) into server/.env`,
    );
  }
  return v;
}

export const db = createClient<Database>(
  env("SUPABASE_URL"),
  env("SUPABASE_SECRET_KEY"),
  { auth: { persistSession: false, autoRefreshToken: false } },
);
