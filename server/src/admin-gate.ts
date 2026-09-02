/**
 * Who may use the admin surface: settings writes, model pulls, ingest, the
 * inbox, discovery, providers, evals, guardrails.
 *
 * Policy only, no request handling. auth.ts turns it into the adminAllowed()
 * check and the requireAdmin middleware, so the policy has one copy and every
 * router hangs off the same one.
 *
 * ADMIN_EMAILS set: a signed-in user on that list is an admin, nobody else.
 * ADMIN_EMAILS unset: closed when NODE_ENV=production, open otherwise. Open is
 * how the app runs on a laptop, and it is said out loud at boot rather than
 * assumed, because a gate nobody knows the shape of is not a gate.
 */
import type { User } from "./types.js";

export function adminAllowlist(): string[] {
  return (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

/** Whether the allowlist is doing anything; surfaced in the panels. */
export function adminGateActive(): boolean {
  return adminAllowlist().length > 0;
}

export type AdminPosture = "allowlist" | "open" | "closed";

/** What the gate does right now, for the boot log and /api/me. */
export function adminPosture(): AdminPosture {
  if (adminGateActive()) return "allowlist";
  return process.env.NODE_ENV === "production" ? "closed" : "open";
}

/** The one decision: may this (possibly signed-out) user use admin routes. */
export function isAdminUser(user: User | null | undefined): boolean {
  switch (adminPosture()) {
    case "allowlist":
      return !!user?.email && adminAllowlist().includes(user.email.toLowerCase());
    case "open":
      return true;
    case "closed":
      return false;
  }
}

/** Say at boot what the gate is doing, loudly when it is doing nothing. */
export function logAdminPosture(): void {
  switch (adminPosture()) {
    case "allowlist":
      console.log("[grapevine] admin surface: " + adminAllowlist().length + " allowlisted account(s)");
      return;
    case "open":
      console.warn(
        "[grapevine] ADMIN_EMAILS is not set: the admin surface (settings, model pulls, ingest, discovery, monitoring) is open to anyone who can reach this port. Fine on a laptop; set it before exposing the server.",
      );
      return;
    case "closed":
      console.warn(
        "[grapevine] ADMIN_EMAILS is not set and NODE_ENV=production: the admin surface is closed to everyone until it is.",
      );
      return;
  }
}
