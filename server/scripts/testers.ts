/**
 * Synthetic tester personas for demo and observability data.
 *
 * The real operator's account must never appear in seeded threads or in
 * Langfuse traces — demo conversations belong to these testers instead.
 * Faker runs with a fixed seed so the same four people exist on every
 * machine and every re-run; emails live on example.com (RFC 2606 reserved,
 * guaranteed to never be a real inbox).
 */
import { createHash } from "node:crypto";
import { faker } from "@faker-js/faker";
import { db } from "../src/db.js";

export interface Tester {
  id: string;
  email: string;
  name: string;
}

faker.seed(20260901);

export const TESTERS: Tester[] = Array.from({ length: 4 }, () => {
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

/** Stable thread → tester assignment, so a session always has one owner. */
export function testerForThread(threadId: string): Tester {
  if (!resolved) throw new Error("call ensureTesters() before testerForThread()");
  const n = parseInt(createHash("sha256").update(threadId).digest("hex").slice(0, 8), 16);
  return resolved[n % resolved.length];
}

/**
 * Create the personas as real (confirmed, passwordless) Supabase Auth users
 * and mirror them into the app's users table. Idempotent: existing rows are
 * matched by email and reused.
 */
export async function ensureTesters(): Promise<Tester[]> {
  if (resolved) return resolved;
  const { data: existing } = await db
    .from("users")
    .select("id, email")
    .in("email", TESTERS.map((t) => t.email))
    .throwOnError();
  const byEmail = new Map(existing.map((u) => [u.email, u.id]));

  const out: Tester[] = [];
  for (const t of TESTERS) {
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
