/** Local CLI availability metadata retained for settings compatibility.
 * Generation is exclusively handled by the typed local LLM gateway.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { cliToolsNote } from "./agent/contracts.js";
import { type CliProviderId, type CliProviderInfo, type CliProviderStatus } from "./types.js";

export type { CliProviderId, CliProviderInfo, CliProviderStatus };

export const CLI_PROVIDERS: CliProviderInfo[] = [
  {
    id: "claude",
    name: "Claude Code",
    vendor: "Anthropic",
    logo: "anthropic",
    bin: "claude",
    installHint: "npm install -g @anthropic-ai/claude-code",
    loginHint: "claude   (then /login)",
    loginNote: "Claude.ai account (Pro/Max subscription), no API key",
  },
  {
    id: "codex",
    name: "Codex CLI",
    vendor: "OpenAI",
    logo: "openai",
    bin: "codex",
    installHint: "npm install -g @openai/codex",
    loginHint: "codex login",
    loginNote: "ChatGPT account (Plus/Pro), no API key",
  },
  {
    id: "gemini",
    name: "Gemini CLI",
    vendor: "Google",
    logo: "google",
    bin: "gemini",
    installHint: "npm install -g @google/gemini-cli",
    loginHint: "gemini   (then pick “Login with Google”)",
    loginNote: "Google account OAuth (free tier), no API key",
  },
  {
    id: "copilot",
    name: "Copilot CLI",
    vendor: "GitHub",
    logo: "github-copilot",
    bin: "copilot",
    installHint: "npm install -g @github/copilot",
    loginHint: "copilot login",
    loginNote: "GitHub account (Copilot subscription), no API key",
  },
];

// ---------------------------------------------------------------------------
// Shelling out (Windows npm shims are .cmd files, so shell:true there; POSIX
// spawns the binary directly so multiline args (Copilot takes its prompt as
// an argument, not stdin) pass through without any quote mangling)
// ---------------------------------------------------------------------------

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** shell:true skips arg escaping; quote anything with whitespace ourselves.
 *  An empty argument must be quoted too, or the shell drops it entirely (that
 *  would silently turn `--tools ""` into a dangling flag). */
function shellArg(s: string): string {
  if (s === "") return '""';
  return /[\s"]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s;
}

const viaShell = process.platform === "win32";

function run(
  bin: string,
  args: string[],
  opts: {
    stdin?: string;
    timeoutMs: number;
    signal?: AbortSignal;
    /** Consume stdout line by line instead of buffering it (NDJSON streams). */
    onLine?: (line: string) => void;
  },
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, viaShell ? args.map(shellArg) : args, {
      shell: viaShell,
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

    let pending = "";
    child.stdout.on("data", (d) => {
      if (!opts.onLine) {
        stdout += d;
        return;
      }
      pending += d;
      for (let nl = pending.indexOf("\n"); nl >= 0; nl = pending.indexOf("\n")) {
        const line = pending.slice(0, nl).trim();
        pending = pending.slice(nl + 1);
        if (line) opts.onLine(line);
      }
    });
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => finish(err));
    child.on("close", (code) => {
      // A stream that ends without a trailing newline still has one last line.
      if (opts.onLine && pending.trim()) opts.onLine(pending.trim());
      pending = "";
      finish(undefined, { code, stdout, stderr });
    });
    if (opts.stdin !== undefined) {
      child.stdin.on("error", () => {}); // EPIPE if the CLI exits early
      child.stdin.write(opts.stdin);
    }
    child.stdin.end();
  });
}

// ---------------------------------------------------------------------------
// Detection: where each CLI caches credentials after its OAuth login
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
    case "copilot": {
      if (process.env.COPILOT_GITHUB_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_TOKEN)
        return { authed: true, authKind: "api-key" };
      // `copilot login` prefers the OS credential store but falls back to
      // plain files under COPILOT_HOME (default ~/.copilot); gh CLI logins
      // (~/.config/gh/hosts.yml) also count per `copilot login --help`.
      const copilotHome = process.env.COPILOT_HOME ?? home(".copilot");
      if (
        fileHas(path.join(copilotHome, "config.json"), "token") ||
        fileHas(path.join(copilotHome, "config.json"), '"user"') ||
        existsSync(path.join(copilotHome, "auth.json")) ||
        existsSync(path.join(copilotHome, "credentials.json")) ||
        fileHas(home(".config", "gh", "hosts.yml"), "oauth_token")
      )
        return { authed: true, authKind: "subscription" };
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
      const auth = installed ? detectAuth(p.id) : ({ authed: false, authKind: null } as const);
      return { ...p, installed, version, ...auth };
    }),
  );
  statusCache = { at: Date.now(), value };
  return value;
}

export function providerInfo(id: CliProviderId): CliProviderInfo {
  return CLI_PROVIDERS.find((p) => p.id === id)!;
}

/** Hosted subscription CLIs cannot satisfy the air-gapped generation contract. */
export function cliSupportsTools(_id: CliProviderId): boolean {
  return false;
}

// ---------------------------------------------------------------------------
// Prompt assembly (the CLIs take one flat prompt per turn)
// ---------------------------------------------------------------------------

export interface Exchange {
  user: string;
  assistant: string;
}

/**
 * History clamp for the flat prompt. Conversation memory itself lives in the
 * LangGraph checkpointer; this legacy formatter remains for compatibility.
 */
const MAX_EXCHANGES = 8;

/** System prompt + recent exchanges + the new message, as one CLI prompt. */
export function buildCliPrompt(
  system: string,
  exchanges: Exchange[],
  message: string,
  opts?: { tools?: boolean },
): string {
  const history = exchanges
    .slice(-MAX_EXCHANGES)
    .map((x) => `User: ${x.user}\nGrapevine: ${x.assistant}`)
    .join("\n\n");
  return [
    system,
    // The reality check for CLI sessions that get MCP tools: the in-app UI
    // tools the system prompt describes do not exist there. Built from the
    // contracts, so it names the tools that actually exist.
    opts?.tools ? cliToolsNote() : "",
    history ? `Conversation so far:\n\n${history}` : "",
    `User: ${message}`,
    "Reply as Grapevine — plain text (with the [Title](event:id) link grammar), no preamble, no code fences.",
  ]
    .filter(Boolean)
    .join("\n\n");
}
