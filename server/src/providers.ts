/**
 * Subscription-authed CLI chat providers — Claude Code, OpenAI Codex, and
 * Gemini CLI as alternatives to the local Ollama agent for "Ask Grapevine".
 *
 * Each CLI brings its own login (claude.ai subscription, ChatGPT account,
 * Google account OAuth), so no API keys ever touch this server: we shell out
 * to the locally installed binary in non-interactive print mode and read the
 * answer back. Detection is filesystem/env-based (where each CLI caches its
 * credentials), never a paid model call.
 *
 * Trade-off vs the LangGraph agent: no tools (map pinning, ETAs, calendar
 * proposals) — answers come from the same event digest baked into the prompt.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type CliProviderId = "claude" | "codex" | "gemini";

export interface CliProviderInfo {
  id: CliProviderId;
  name: string;
  vendor: string;
  /** models.dev logo id (served via /api/logo/:id) */
  logo: string;
  bin: string;
  installHint: string;
  /** Command(s) that set up key-less auth. */
  loginHint: string;
  /** What account the login uses. */
  loginNote: string;
}

export const CLI_PROVIDERS: CliProviderInfo[] = [
  {
    id: "claude",
    name: "Claude Code",
    vendor: "Anthropic",
    logo: "anthropic",
    bin: "claude",
    installHint: "npm install -g @anthropic-ai/claude-code",
    loginHint: "claude   (then /login)",
    loginNote: "Claude.ai account (Pro/Max subscription) — no API key",
  },
  {
    id: "codex",
    name: "Codex CLI",
    vendor: "OpenAI",
    logo: "openai",
    bin: "codex",
    installHint: "npm install -g @openai/codex",
    loginHint: "codex login",
    loginNote: "ChatGPT account (Plus/Pro) — no API key",
  },
  {
    id: "gemini",
    name: "Gemini CLI",
    vendor: "Google",
    logo: "google",
    bin: "gemini",
    installHint: "npm install -g @google/gemini-cli",
    loginHint: "gemini   (then pick “Login with Google”)",
    loginNote: "Google account OAuth (free tier) — no API key",
  },
];

export interface CliProviderStatus extends CliProviderInfo {
  installed: boolean;
  version: string | null;
  authed: boolean;
  authKind: "subscription" | "api-key" | null;
}

// ---------------------------------------------------------------------------
// Shelling out (Windows npm shims are .cmd files, so shell:true everywhere)
// ---------------------------------------------------------------------------

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** shell:true skips arg escaping — quote anything with whitespace ourselves. */
function shellArg(s: string): string {
  return /[\s"]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s;
}

function run(
  bin: string,
  args: string[],
  opts: { stdin?: string; timeoutMs: number; signal?: AbortSignal },
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args.map(shellArg), {
      shell: true,
      cwd: os.tmpdir(), // neutral cwd: no repo context, no project config pickup
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => finish(new Error(`${bin} timed out`)), opts.timeoutMs);
    const onAbort = () => finish(new Error("aborted"));
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    function finish(err?: Error, result?: RunResult) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      if (err) {
        child.kill();
        reject(err);
      } else {
        resolve(result!);
      }
    }

    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => finish(err));
    child.on("close", (code) => finish(undefined, { code, stdout, stderr }));
    if (opts.stdin !== undefined) {
      child.stdin.on("error", () => {}); // EPIPE if the CLI exits early
      child.stdin.write(opts.stdin);
    }
    child.stdin.end();
  });
}

// ---------------------------------------------------------------------------
// Detection — where each CLI caches credentials after its OAuth login
// ---------------------------------------------------------------------------

function home(...segments: string[]): string {
  return path.join(os.homedir(), ...segments);
}

function fileHas(file: string, needle: string): boolean {
  try {
    return readFileSync(file, "utf8").includes(needle);
  } catch {
    return false;
  }
}

function detectAuth(id: CliProviderId): Pick<CliProviderStatus, "authed" | "authKind"> {
  switch (id) {
    case "claude": {
      if (
        existsSync(home(".claude", ".credentials.json")) ||
        fileHas(home(".claude.json"), '"oauthAccount"') || // macOS keeps tokens in Keychain
        process.env.CLAUDE_CODE_OAUTH_TOKEN
      )
        return { authed: true, authKind: "subscription" };
      if (process.env.ANTHROPIC_API_KEY) return { authed: true, authKind: "api-key" };
      return { authed: false, authKind: null };
    }
    case "codex": {
      const auth = home(".codex", "auth.json");
      if (existsSync(auth)) {
        try {
          const parsed = JSON.parse(readFileSync(auth, "utf8"));
          return parsed?.tokens
            ? { authed: true, authKind: "subscription" }
            : { authed: true, authKind: "api-key" };
        } catch {
          return { authed: true, authKind: "subscription" };
        }
      }
      if (process.env.OPENAI_API_KEY) return { authed: true, authKind: "api-key" };
      return { authed: false, authKind: null };
    }
    case "gemini": {
      if (existsSync(home(".gemini", "oauth_creds.json")))
        return { authed: true, authKind: "subscription" };
      if (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY)
        return { authed: true, authKind: "api-key" };
      return { authed: false, authKind: null };
    }
  }
}

let statusCache: { at: number; value: CliProviderStatus[] } | null = null;
const STATUS_TTL_MS = 30_000;

export async function detectProviders(force = false): Promise<CliProviderStatus[]> {
  if (!force && statusCache && Date.now() - statusCache.at < STATUS_TTL_MS) {
    return statusCache.value;
  }
  const value = await Promise.all(
    CLI_PROVIDERS.map(async (p) => {
      let installed = false;
      let version: string | null = null;
      try {
        const r = await run(p.bin, ["--version"], { timeoutMs: 10_000 });
        installed = r.code === 0;
        version = r.stdout.trim().split("\n")[0]?.trim() || null;
      } catch {
        /* not installed / not on PATH */
      }
      // Stale credential files shouldn't report an uninstalled CLI as ready.
      const auth = installed
        ? detectAuth(p.id)
        : ({ authed: false, authKind: null } as const);
      return { ...p, installed, version, ...auth };
    }),
  );
  statusCache = { at: Date.now(), value };
  return value;
}

export function providerInfo(id: CliProviderId): CliProviderInfo {
  return CLI_PROVIDERS.find((p) => p.id === id)!;
}

// ---------------------------------------------------------------------------
// Chat — one prompt in, one answer out, per provider
// ---------------------------------------------------------------------------

const CLI_TIMEOUT_MS = 110_000; // under the route's 120s deadline

export async function cliChat(
  id: CliProviderId,
  prompt: string,
  signal?: AbortSignal,
): Promise<string> {
  switch (id) {
    case "claude": {
      const r = await run("claude", ["-p", "--output-format", "text"], {
        stdin: prompt,
        timeoutMs: CLI_TIMEOUT_MS,
        signal,
      });
      if (r.code !== 0) throw cliError("claude", r);
      return r.stdout.trim();
    }
    case "codex": {
      // --output-last-message is the stable way to get just the final answer
      // (plain stdout mixes in session headers and progress logs).
      const dir = await mkdtemp(path.join(os.tmpdir(), "grapevine-codex-"));
      const outFile = path.join(dir, "last-message.txt");
      try {
        const r = await run(
          "codex",
          ["exec", "--skip-git-repo-check", "--output-last-message", outFile, "-"],
          { stdin: prompt, timeoutMs: CLI_TIMEOUT_MS, signal },
        );
        const answer = await readFile(outFile, "utf8").then((s) => s.trim()).catch(() => "");
        if (answer) return answer;
        if (r.code !== 0) throw cliError("codex", r);
        return r.stdout.trim();
      } finally {
        rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    }
    case "gemini": {
      const r = await run("gemini", [], {
        stdin: prompt,
        timeoutMs: CLI_TIMEOUT_MS,
        signal,
      });
      if (r.code !== 0) throw cliError("gemini", r);
      // some versions prepend credential-cache chatter on stdout
      return r.stdout.replace(/^Loaded cached credentials\.?\s*/i, "").trim();
    }
  }
}

function cliError(bin: string, r: RunResult): Error {
  const detail = (r.stderr || r.stdout).trim().split("\n").slice(-3).join(" ").slice(0, 300);
  return new Error(`${bin} exited with code ${r.code}${detail ? `: ${detail}` : ""}`);
}

// ---------------------------------------------------------------------------
// Per-thread transcripts (CLI mode has no LangGraph checkpointer)
// ---------------------------------------------------------------------------

interface Exchange {
  user: string;
  assistant: string;
}

const MAX_THREADS = 200;
const MAX_EXCHANGES = 8;
const transcripts = new Map<string, Exchange[]>();

export function cliTranscript(threadId: string): Exchange[] {
  return transcripts.get(threadId) ?? [];
}

export function pushCliTranscript(threadId: string, user: string, assistant: string): void {
  const list = transcripts.get(threadId) ?? [];
  list.push({ user, assistant });
  while (list.length > MAX_EXCHANGES) list.shift();
  transcripts.delete(threadId); // re-insert → Map keeps insertion order = LRU
  transcripts.set(threadId, list);
  while (transcripts.size > MAX_THREADS) {
    const oldest = transcripts.keys().next().value;
    if (oldest === undefined) break;
    transcripts.delete(oldest);
  }
}

/** System prompt + rolling transcript + the new message, as one CLI prompt. */
export function buildCliPrompt(system: string, threadId: string, message: string): string {
  const history = cliTranscript(threadId)
    .map((x) => `User: ${x.user}\nGrapevine: ${x.assistant}`)
    .join("\n\n");
  return [
    system,
    history ? `Conversation so far:\n\n${history}` : "",
    `User: ${message}`,
    "Reply as Grapevine — plain text (with the [Title](event:id) link grammar), no preamble, no code fences.",
  ]
    .filter(Boolean)
    .join("\n\n");
}
