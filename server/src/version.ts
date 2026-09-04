/**
 * What is running: the package version, the release stamp the operator set,
 * and the commit, read once at boot. /version reports it, the MCP server
 * announces it, and Langfuse spans carry the release as service.version.
 */
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const pkg = createRequire(import.meta.url)("../package.json") as { version: string };

function commit(): string | null {
  if (process.env.GRAPEVINE_COMMIT) return process.env.GRAPEVINE_COMMIT;
  try {
    const sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2_000,
    }).trim();
    return sha || null;
  } catch {
    return null; // not a checkout (a container image, a tarball)
  }
}

export const VERSION = {
  name: "grapevine",
  version: pkg.version,
  /** GRAPEVINE_RELEASE: any string the operator chose, a date or a tag. */
  release: process.env.GRAPEVINE_RELEASE ?? null,
  /** GRAPEVINE_COMMIT, else git at boot, else null. */
  commit: commit(),
  node: process.version,
} as const;
