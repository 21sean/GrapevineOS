/**
 * Shared-secret hygiene: refuse to boot on placeholder values, and compare
 * keys in constant time.
 *
 * Both exist because the failure they prevent is silent. A server that starts
 * with INGEST_SHARED_KEY=change_me accepts every inbound ping from anyone who
 * has read the example file, and a plain === on a shared key returns as soon
 * as the first byte differs, which tells a patient caller how much of a guess
 * was right.
 */
import { createHash, timingSafeEqual } from "node:crypto";

/** The example values shipped in server/.env.example, by shape. */
const PLACEHOLDER = /^(change_?me)(_.*)?$|your[_-]|^GOCSPX-your|\.your_|^(sk|pk)\.your/i;

/** Secrets that must not keep their example value once they are set at all. */
const SECRETS = [
  "SUPABASE_SECRET_KEY",
  "MAPBOX_SECRET_TOKEN",
  "INGEST_SHARED_KEY",
  "AGENT_API_KEY",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "LANGFUSE_PUBLIC_KEY",
  "LANGFUSE_SECRET_KEY",
  "GUARDRAIL_HASH_SALT",
];

/**
 * Throws with every offending variable named at once, so the operator fixes
 * the env file in one pass rather than one boot per variable. An unset secret
 * is fine: each feature that needs one switches itself off without it.
 */
export function validateSecrets(env: NodeJS.ProcessEnv = process.env): void {
  const bad = SECRETS.filter((name) => env[name] && PLACEHOLDER.test(env[name] ?? ""));
  if (env.SUPABASE_URL && /your-project/.test(env.SUPABASE_URL)) bad.push("SUPABASE_URL");
  if (bad.length) {
    const verb = bad.length === 1 ? "has" : "have";
    throw new Error(
      `refusing to start: ${bad.join(", ")} still ${verb} the example value from server/.env.example`,
    );
  }
}

/**
 * Constant-time equality for shared keys. Both sides are hashed first so the
 * comparison is fixed-length and a length mismatch cannot short-circuit it.
 * Missing on either side is never equal.
 */
export function safeEqual(given: string | undefined | null, expected: string | undefined | null): boolean {
  if (!given || !expected) return false;
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}
