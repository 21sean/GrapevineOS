/**
 * Synthetic tester personas for demo and observability data.
 *
 * The real operator's account must never appear in seeded threads or in
 * Langfuse traces — demo conversations belong to these testers instead.
 * Faker runs with a fixed seed so the same people exist on every machine and
 * every re-run; emails live on example.com (RFC 2606 reserved, guaranteed to
 * never be a real inbox).
 *
 * The pool grew from 4 to 30 for the Langfuse traffic simulator, which needs a
 * believable long tail of visitors rather than four people using the product
 * forever. Growing it is append-only by construction: faker.seed() plus an
 * unchanged generator body means draws 1-4 stay byte-identical, so the four
 * original identities survive.
 *
 * What does NOT survive a bigger pool is the assignment function. It hashes a
 * thread id and indexes `n % pool.length`, so widening the pool would hand 14
 * of the 15 already-ingested Langfuse threads to different owners and silently
 * rewrite history in the Sessions and Users tabs. Two functions therefore:
 *
 *  - testerForThread() stays pinned to the first four and is what real seeded
 *    chat_threads rows use. Those four are the only personas that need a
 *    Supabase Auth user, because public.users.id has a foreign key into
 *    auth.users and a thread must have a real owner.
 *  - Everything else reads TESTERS directly and weights it however it likes.
 *    The Langfuse traffic simulator does exactly that, and touches no database
 *    at all: Langfuse user ids are free-form strings, so simulated traffic that
 *    never writes a chat_threads row needs no account anywhere.
 */
import { createHash } from "node:crypto";
import { faker } from "@faker-js/faker";
import { db } from "../src/db.js";

export interface Tester {
  id: string;
  email: string;
  name: string;
}

/** How many personas own real database rows. Do not change: see the header. */
export const LEGACY_POOL = 4;

faker.seed(20260901);

export const TESTERS: Tester[] = Array.from({ length: 30 }, () => {
  const firstName = faker.person.firstName();
  const lastName = faker.person.lastName();
  const email = faker.internet
    .email({ firstName, lastName, provider: "example.com" })
    .toLowerCase();
  // The id is assigned by Supabase Auth on first creation (public.users has
  // a foreign key into auth.users, so a made-up uuid cannot exist there).
  return { id: "", email, name: `${firstName} ${lastName}` };
});

let resolved: Tester[] | null = null;

function hashIndex(key: string, modulo: number): number {
  const n = parseInt(createHash("sha256").update(key).digest("hex").slice(0, 8), 16);
  return n % modulo;
}

/**
 * Stable thread → tester assignment for threads that exist in the database, so
 * a session always has one owner. Pinned to the first four personas: those are
 * the owners the existing seeded threads and Langfuse traces already carry.
 */
export function testerForThread(threadId: string): Tester {
  if (!resolved) throw new Error("call ensureTesters() before testerForThread()");
  return resolved[hashIndex(threadId, resolved.length)];
}

/**
 * Create the personas that own real rows as confirmed, passwordless Supabase
 * Auth users and mirror them into the app's users table. Idempotent: existing
 * rows are matched by email and reused. Only the legacy four are provisioned —
 * the other 26 exist solely as Langfuse user ids and need no account.
 */
export async function ensureTesters(): Promise<Tester[]> {
  if (resolved) return resolved;
  const owners = TESTERS.slice(0, LEGACY_POOL);
  const { data: existing } = await db
    .from("users")
    .select("id, email")
    .in("email", owners.map((t) => t.email))
    .throwOnError();
  const byEmail = new Map(existing.map((u) => [u.email, u.id]));

  const out: Tester[] = [];
  for (const t of owners) {
    let id = byEmail.get(t.email);
    if (!id) {
      const { data, error } = await db.auth.admin.createUser({
        email: t.email,
        email_confirm: true,
        user_metadata: { name: t.name, tester: true },
      });
      if (error) throw error;
      id = data.user.id;
      await db
        .from("users")
        .upsert({ id, email: t.email, name: t.name, picture: "", prefs: {} })
        .throwOnError();
    }
    out.push({ ...t, id });
  }
  resolved = out;
  return out;
}
