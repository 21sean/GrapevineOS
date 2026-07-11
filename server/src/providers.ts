/**
 * Subscription-authed CLI providers — Claude Code, OpenAI Codex, Gemini CLI,
 * and GitHub Copilot CLI as alternatives to the local Ollama model, both for
 * "Ask Grapevine" chat and for the newsletter extraction pipeline (llm.ts).
 *
 * Each CLI brings its own login (claude.ai subscription, ChatGPT account,
 * Google account OAuth, GitHub account), so no API keys ever touch this
 * server: we shell out to the locally installed binary in non-interactive
 * print mode and read the answer back. Detection is filesystem/env-based
 * (where each CLI caches its credentials), never a paid model call.
 *
 * Trade-off vs the LangGraph agent: no *UI* tools (map pinning, filter
 * changes, in-chat proposals). Claude Code narrows the gap by connecting back
 * to this server's own MCP endpoint (/mcp), which restores event search,
 * details, ETAs, and calendar saves; Codex, Gemini, and Copilot read MCP
 * config from user-global files we won't touch, so they stay digest-only.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { INTERNAL_MCP_KEY } from "./auth.js";

export type CliProviderId = "claude" | "codex" | "gemini" | "copilot";

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
  {
    id: "copilot",
    name: "Copilot CLI",
    vendor: "GitHub",
    logo: "github-copilot",
    bin: "copilot",
    installHint: "npm install -g @github/copilot",
    loginHint: "copilot login",
    loginNote: "GitHub account (Copilot subscription) — no API key",
  },
];

export interface CliProviderStatus extends CliProviderInfo {
  installed: boolean;
  version: string | null;
  authed: boolean;
  authKind: "subscription" | "api-key" | null;
}

// ---------------------------------------------------------------------------
// Shelling out (Windows npm shims are .cmd files, so shell:true there; POSIX
// spawns the binary directly so multiline args — Copilot takes its prompt as
// an argument, not stdin — pass through without any quote mangling)
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

const viaShell = process.platform === "win32";

function run(
  bin: string,
  args: string[],
  opts: { stdin?: string; timeoutMs: number; signal?: AbortSignal },
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
    case "copilot": {
      if (
        process.env.COPILOT_GITHUB_TOKEN ||
        process.env.GH_TOKEN ||
        process.env.GITHUB_TOKEN
      )
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

/** CLIs we can point at Grapevine's own MCP endpoint per-invocation. */
export function cliSupportsTools(id: CliProviderId): boolean {
  return id === "claude";
}

/** Where a CLI on this machine reaches the MCP server (same express app). */
function mcpEndpoint(): string {
  const base = process.env.MCP_PUBLIC_URL ?? `http://localhost:${process.env.PORT ?? 8787}`;
  return `${base.replace(/\/$/, "")}/mcp`;
}

export async function cliChat(
  id: CliProviderId,
  prompt: string,
  signal?: AbortSignal,
  opts?: { tools?: boolean },
): Promise<string> {
  const tools = opts?.tools ?? cliSupportsTools(id);
  switch (id) {
    case "claude": {
      // --strict-mcp-config keeps the user's own MCP servers out either way;
      // with tools on, --mcp-config points back at Grapevine's own /mcp via a
      // temp file (inline JSON quoting is fragile under shell:true on
      // Windows) and --allowedTools mcp__grapevine pre-approves only ours.
      const dir = tools
        ? await mkdtemp(path.join(os.tmpdir(), "grapevine-claude-"))
        : null;
      let mcpArgs: string[] = ["--strict-mcp-config"];
      if (dir) {
        const cfgFile = path.join(dir, "mcp.json");
        await writeFile(
          cfgFile,
          JSON.stringify({
            mcpServers: {
              grapevine: {
                type: "http",
                url: mcpEndpoint(),
                // Per-boot internal key — the loopback never does OAuth.
                headers: { "X-Agent-Key": INTERNAL_MCP_KEY },
              },
            },
          }),
        );
        mcpArgs = [
          "--mcp-config",
          cfgFile,
          "--strict-mcp-config",
          "--allowedTools",
          "mcp__grapevine",
        ];
      }
      try {
        const r = await run(
          "claude",
          ["-p", "--output-format", "text", ...mcpArgs],
          { stdin: prompt, timeoutMs: CLI_TIMEOUT_MS, signal },
        );
        if (r.code !== 0) throw cliError("claude", r);
        return r.stdout.trim();
      } finally {
        if (dir) rm(dir, { recursive: true, force: true }).catch(() => {});
      }
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
    case "copilot": {
      // Copilot has no stdin prompt mode — the prompt rides -p as an argv
      // (fine on POSIX where run() spawns without a shell; on Windows,
      // multiline prompts don't survive cmd.exe quoting). -s strips the
      // stats footer; --disable-builtin-mcps keeps the bundled GitHub MCP
      // server out of a pure Q&A turn.
      const r = await run(
        "copilot",
        [
          "-p",
          prompt,
          "-s",
          "--no-color",
          "--no-auto-update",
          "--no-custom-instructions",
          "--disable-builtin-mcps",
          "--log-level",
          "none",
        ],
        { timeoutMs: CLI_TIMEOUT_MS, signal },
      );
      if (r.code !== 0) throw cliError("copilot", r);
      return r.stdout.trim();
    }
  }
}

function cliError(bin: string, r: RunResult): Error {
  const detail = (r.stderr || r.stdout).trim().split("\n").slice(-3).join(" ").slice(0, 300);
  return new Error(`${bin} exited with code ${r.code}${detail ? `: ${detail}` : ""}`);
}

// ---------------------------------------------------------------------------
// JSON tasks — the extraction/rating pipeline through a CLI instead of Ollama
// ---------------------------------------------------------------------------

/** Salvage a JSON object from chatty CLI output (fences, preamble, epilogue). */
export function parseLooseJSON(text: string): any {
  const cleaned = text
    .replace(/<think>[\s\S]*?<\/think>/g, "")
    .replace(/```(?:json)?/g, "")
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    // fall through to the outermost {...} span
  }
  const first = cleaned.indexOf("{");
  const last = cleaned.lastIndexOf("}");
  if (first !== -1 && last > first) {
    return JSON.parse(cleaned.slice(first, last + 1));
  }
  throw new Error(`model returned unparseable JSON: ${cleaned.slice(0, 200)}`);
}

/**
 * One system+user exchange through a CLI provider, parsed as JSON. Tools stay
 * off — extraction is a pure text-in/JSON-out task, so there's no reason to
 * pay the MCP handshake or let the model wander.
 */
export async function cliJSON(
  id: CliProviderId,
  opts: { system: string; user: string; signal?: AbortSignal },
): Promise<any> {
  const prompt = [
    opts.system,
    opts.user,
    "Return ONLY the JSON object described above — no prose, no markdown fences.",
  ].join("\n\n");
  const raw = await cliChat(id, prompt, opts.signal, { tools: false });
  return parseLooseJSON(raw);
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

/** Reality check for CLI sessions that get MCP tools: the in-app UI tools the
 * system prompt describes don't exist there — remap to the MCP toolbox. */
const CLI_TOOLS_NOTE = `Tools in this session: you are connected to the "grapevine" MCP server —
search_events, get_event, get_eta, list_saved_events, save_event, unsave_event,
set_event_rarity, update_interests. The in-app tools mentioned above
(show_on_map, set_filters, propose_calendar, save_calendar, search_web,
read_page) do NOT exist here: never claim to have pinned the map or changed
filters. Recommend events in text with the [Title](event:id) grammar, use
search_events/get_event beyond the digest, get_eta for travel questions, and
save_event/unsave_event only when the user explicitly asks (saves land on the
linked Grapevine account).`;

/** System prompt + rolling transcript + the new message, as one CLI prompt. */
export function buildCliPrompt(
  system: string,
  threadId: string,
  message: string,
  opts?: { tools?: boolean },
): string {
  const history = cliTranscript(threadId)
    .map((x) => `User: ${x.user}\nGrapevine: ${x.assistant}`)
    .join("\n\n");
  return [
    system,
    opts?.tools ? CLI_TOOLS_NOTE : "",
    history ? `Conversation so far:\n\n${history}` : "",
    `User: ${message}`,
    "Reply as Grapevine — plain text (with the [Title](event:id) link grammar), no preamble, no code fences.",
  ]
    .filter(Boolean)
    .join("\n\n");
}
