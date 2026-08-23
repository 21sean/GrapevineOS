/**
 * Who may use the admin-only HTTP surfaces (Evals, Guardrails).
 *
 * When ADMIN_EMAILS is set these routes require a signed-in user on that list;
 * unset, they are open exactly like the rest of the admin surface, which is
 * how this app is run locally. That default is deliberate and is stated out
 * loud in the panels rather than assumed — a gate nobody knows the shape of is
 * not a gate.
 *
 * One copy, because two panels quietly disagreeing about who counts as an
 * admin is the kind of difference nobody notices until it matters.
 */
import type { Request } from "express";
import { sessionUser } from "./auth.js";

export function adminAllowlist(): string[] {
  return (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

/** True when the caller may use the admin routes. */
export async function adminAllowed(req: Request): Promise<boolean> {
  const list = adminAllowlist();
  if (!list.length) return true; // unset: same posture as the rest of admin
  const user = await sessionUser(req).catch(() => null);
  return !!user?.email && list.includes(user.email.toLowerCase());
}

/** Whether the allowlist is doing anything — surfaced in the panels. */
export function adminGateActive(): boolean {
  return adminAllowlist().length > 0;
}
