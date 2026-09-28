/**
 * Supabase client: the server's single connection to Postgres.
 *
 * supabase-js talks PostgREST over HTTPS (no raw Postgres connection), so
 * there is no pool to manage and it works from any network, which is exactly
 * what the free tier wants. The secret key bypasses RLS; it lives only in
 * server/.env and must never be sent to the browser.
 *
 * Queries chain .throwOnError(), so callers get typed data or an exception;
 * route handlers catch and translate to HTTP errors.
 *
 * The client is built on first use rather than at import. Importing this
 * module used to throw when the keys were absent, which meant anything that
 * merely sat in the same import graph (the offline eval suites, a typecheck
 * script, a one-off tool) needed production credentials to load code it was
 * never going to call. Missing keys still fail loudly, just at the first query
 * instead of at startup.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "./db-types.js";

function env(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(
      `${name} is not set. Copy it from the Supabase dashboard ` +
        `(Settings → API) into server/.env`,
    );
  }
  return v;
}

let client: SupabaseClient<Database> | null = null;

function connection(): SupabaseClient<Database> {
  return (client ??= createClient<Database>(env("SUPABASE_URL"), env("SUPABASE_SECRET_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  }));
}

/**
 * Behaves exactly like the client it stands in for (`db.from(...)`,
 * `db.rpc(...)`, `db.storage`) but resolves it on first property access.
 * Methods are bound to the real client so `this` is never the proxy.
 */
export const db: SupabaseClient<Database> = new Proxy({} as SupabaseClient<Database>, {
  get(_target, prop) {
    const c = connection() as unknown as Record<string | symbol, unknown>;
    const value = c[prop];
    return typeof value === "function" ? value.bind(c) : value;
  },
  has: (_target, prop) => prop in (connection() as object),
});
