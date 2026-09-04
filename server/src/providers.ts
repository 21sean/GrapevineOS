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
import { cliToolsNote, toolLabel } from "./agent/contracts.js";
import { INTERNAL_MCP_KEY } from "./auth.js";
import { llmPolicy } from "./budget.js";
import { parseLooseJSON } from "./llm-json.js";
import {
  isChatEffort,
  type ChatEffort,
  type ChatUsage,
  type CliProviderId,
  type CliProviderInfo,
  type CliProviderStatus,
} from "./types.js";
import { apiOrigin } from "./urls.js";

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

/** shell:true skips arg escaping — quote anything with whitespace ourselves.
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

// ---------------------------------------------------------------------------
// Chat — one prompt in, one answer out, per provider
// ---------------------------------------------------------------------------

/** From the one LLM policy (budget.ts); under the chat route's 120s deadline. */
const CLI_TIMEOUT_MS = llmPolicy("claude").timeoutMs;

/** CLIs we can point at Grapevine's own MCP endpoint per-invocation. */
export function cliSupportsTools(id: CliProviderId): boolean {
  return id === "claude";
}

export interface CliChatResult {
  text: string;
  /** Token/cost telemetry, when the provider reports it (Claude Code only). */
  usage?: ChatUsage;
}

/**
 * Live progress from a CLI turn. Claude Code is the only provider that can
 * report it (`--output-format stream-json`); supplying `onText` is what
 * switches that mode on. Without it a turn is a single blocking call, which is
 * a long stare at a spinner when the model is also making tool calls.
 */
export interface CliStreamEvents {
  /** Visible answer text, as it arrives. */
  onText?: (chunk: string) => void;
  /** First reasoning token — the UI can say "thinking" before any text lands. */
  onThinking?: () => void;
  /** One "start" per tool call, one "done" when its result comes back. */
  onTool?: (run: { label: string; state: "start" | "done"; detail?: string }) => void;
}

/** Guard the `--model` value before it reaches an argv: it is spawned under a
 *  shell on Windows, so a stray metacharacter would otherwise break out. Model
 *  ids are `[a-z0-9._:-]` only, so anything else is rejected (falls back to the
 *  CLI's own default). */
function safeModel(model: string | undefined): string | null {
  const m = model?.trim();
  return m && /^[\w.:-]+$/.test(m) ? m : null;
}

/** Dated snapshot ids (claude-haiku-4-5-20251001) label as their alias. */
function canonicalModelId(model: string | undefined): string | undefined {
  return model?.replace(/-\d{8}$/, "");
}

/**
 * Pull per-call token + cost telemetry out of a `claude -p` envelope — the
 * `--output-format json` result object and the final `result` line of a
 * stream-json run share this shape.
 *
 * Two things the literal reading gets wrong:
 *  - `usage.input_tokens` counts only the *uncached* prefix, so a turn that
 *    reads 30k tokens from cache reports single digits, which reads as
 *    nonsense next to the cost. What we show is fresh + cache read + cache
 *    write: what the turn actually processed.
 *  - The CLI bills small side calls (topic titles, routing) to a cheaper
 *    model, and those can carry more *input* tokens than the real turn does
 *    once caching is in play — ranking `modelUsage` by total tokens therefore
 *    picks the side call and mislabels the reply. Prefer the model the stream
 *    reported on its assistant messages, then the entry that wrote the most
 *    output.
 */
function extractCliUsage(
  env: Record<string, unknown>,
  answeringModel?: string,
): ChatUsage | undefined {
  const num = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isFinite(v) ? v : undefined;

  const usageBlock =
    env.usage && typeof env.usage === "object" ? (env.usage as Record<string, unknown>) : null;
  const modelUsage =
    env.modelUsage && typeof env.modelUsage === "object"
      ? (env.modelUsage as Record<string, Record<string, unknown>>)
      : null;

  let model = answeringModel ?? (typeof env.model === "string" ? env.model : undefined);
  let busiest: Record<string, unknown> | undefined;
  if (modelUsage) {
    let mostOutput = -1;
    for (const [name, entry] of Object.entries(modelUsage)) {
      if (!entry || typeof entry !== "object") continue;
      const out = num(entry.outputTokens) ?? 0;
      if (out <= mostOutput) continue;
      mostOutput = out;
      busiest = entry;
      if (!answeringModel) model = name;
    }
  }

  const fresh = num(usageBlock?.input_tokens) ?? num(busiest?.inputTokens);
  const outputTokens = num(usageBlock?.output_tokens) ?? num(busiest?.outputTokens);
  if (fresh === undefined && outputTokens === undefined) return undefined;
  const cacheRead = num(usageBlock?.cache_read_input_tokens) ?? num(busiest?.cacheReadInputTokens);
  const cacheWrite =
    num(usageBlock?.cache_creation_input_tokens) ?? num(busiest?.cacheCreationInputTokens);

  return {
    inputTokens: (fresh ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0),
    outputTokens: outputTokens ?? 0,
    cacheReadInputTokens: cacheRead,
    cacheCreationInputTokens: cacheWrite,
    costUSD: num(env.total_cost_usd) ?? num(busiest?.costUSD),
    model: canonicalModelId(model),
  };
}

/** The claude JSON envelope carries the answer in `result`; older/failed runs
 *  may emit plain text despite `--output-format json`, so fall back to the raw
 *  stdout when it doesn't parse. */
function parseClaudeEnvelope(stdout: string): CliChatResult {
  const trimmed = stdout.trim();
  try {
    const env = JSON.parse(trimmed) as Record<string, unknown>;
    const text = typeof env.result === "string" ? env.result.trim() : trimmed;
    return { text, usage: extractCliUsage(env) };
  } catch {
    return { text: trimmed };
  }
}

/** "mcp__grapevine__search_events" is the contract's search_events. */
function mcpToolName(name: unknown): string {
  return String(name ?? "tool").replace(/^mcp__[^_]+__/, "");
}

/** One identifying argument, so two searches in a row don't look identical. */
function argHint(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const o = input as Record<string, unknown>;
  const hint = o.query ?? o.event_id ?? o.id ?? o.near;
  return typeof hint === "string" && hint ? hint.slice(0, 60) : undefined;
}

/**
 * A Claude Code turn read as it happens: `--output-format stream-json` emits
 * one JSON object per line, and `--include-partial-messages` adds the token
 * deltas. Text goes out as it arrives, tool calls surface as they start and
 * finish, and the closing `result` line carries the authoritative answer plus
 * the usage envelope.
 */
async function claudeStream(
  args: string[],
  prompt: string,
  signal: AbortSignal | undefined,
  events: CliStreamEvents,
): Promise<CliChatResult> {
  let streamed = "";
  let finalText: string | undefined;
  let answeringModel: string | undefined;
  let usage: ChatUsage | undefined;
  let failure: string | undefined;
  let announcedThinking = false;
  // tool_use id -> label, so the "done" event can name the run it closes.
  const openTools = new Map<string, string>();

  const onLine = (line: string) => {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // non-JSON chatter (progress banners) is not ours to read
    }
    switch (msg?.type) {
      case "stream_event": {
        const delta = msg.event?.type === "content_block_delta" ? msg.event.delta : null;
        if (delta?.type === "text_delta" && typeof delta.text === "string") {
          streamed += delta.text;
          events.onText?.(delta.text);
        } else if (delta?.type === "thinking_delta" && !announcedThinking) {
          announcedThinking = true;
          events.onThinking?.();
        }
        return;
      }
      case "assistant": {
        const message = msg.message ?? {};
        if (typeof message.model === "string") answeringModel = message.model;
        // Assistant frames repeat as the message grows — dedupe on block id.
        for (const block of message.content ?? []) {
          if (block?.type !== "tool_use" || openTools.has(block.id)) continue;
          const name = mcpToolName(block.name);
          const label = toolLabel(name, (block.input ?? {}) as Record<string, unknown>);
          openTools.set(block.id, label);
          events.onTool?.({ label, state: "start", detail: argHint(block.input) });
        }
        return;
      }
      case "user": {
        for (const block of msg.message?.content ?? []) {
          if (block?.type !== "tool_result") continue;
          const label = openTools.get(block.tool_use_id);
          if (!label) continue;
          openTools.delete(block.tool_use_id);
          events.onTool?.({
            label,
            state: "done",
            ...(block.is_error && { detail: "failed" }),
          });
        }
        return;
      }
      case "result": {
        if (typeof msg.result === "string") finalText = msg.result;
        if (msg.is_error) failure = String(msg.result ?? msg.subtype ?? "unknown error");
        usage = extractCliUsage(msg, answeringModel);
        return;
      }
    }
  };

  const r = await run("claude", args, {
    stdin: prompt,
    timeoutMs: CLI_TIMEOUT_MS,
    signal,
    onLine,
  });
  if (failure) throw new Error(`claude failed: ${failure.slice(0, 300)}`);
  if (r.code !== 0) throw cliError("claude", r);
  // Deltas are the live view; `result` is the answer the CLI stands behind.
  return { text: (finalText ?? streamed).trim(), usage };
}

/** Where a CLI on this machine reaches the MCP server (same express app). */
function mcpEndpoint(): string {
  return `${apiOrigin()}/mcp`;
}

export async function cliChat(
  id: CliProviderId,
  prompt: string,
  signal?: AbortSignal,
  opts?: {
    tools?: boolean;
    model?: string;
    effort?: ChatEffort;
    /** Supply onText to stream the turn instead of blocking on it. */
    events?: CliStreamEvents;
  },
): Promise<CliChatResult> {
  const tools = opts?.tools ?? cliSupportsTools(id);
  switch (id) {
    case "claude": {
      // --strict-mcp-config keeps the user's own MCP servers out either way;
      // with tools on, --mcp-config points back at Grapevine's own /mcp via a
      // temp file (inline JSON quoting is fragile under shell:true on
      // Windows) and --allowedTools mcp__grapevine pre-approves only ours.
      const dir = tools ? await mkdtemp(path.join(os.tmpdir(), "grapevine-claude-")) : null;
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
      // --model / --effort are optional; empty lets the CLI use whatever the
      // user's subscription defaults to.
      const model = safeModel(opts?.model);
      const args = ["-p"];
      if (model) args.push("--model", model);
      if (opts?.effort && isChatEffort(opts.effort)) args.push("--effort", opts.effort);
      // Built-in tools stay off. The concierge's whole toolbox is Grapevine's
      // own MCP server, and leaving Bash/Read/Write enabled would hand a chat
      // turn the run of the server machine — while also tempting the model to
      // answer event questions with a generic web search instead of
      // discover_events, which is what actually adds them to the catalog.
      args.push("--tools", "");
      // stream-json gives token deltas and tool events; plain json is one
      // blocking call, which is all the extraction pipeline needs.
      const streaming = !!opts?.events?.onText;
      args.push("--output-format", streaming ? "stream-json" : "json");
      if (streaming) args.push("--include-partial-messages", "--verbose");
      args.push(...mcpArgs);
      try {
        if (streaming) return await claudeStream(args, prompt, signal, opts!.events!);
        const r = await run("claude", args, {
          stdin: prompt,
          timeoutMs: CLI_TIMEOUT_MS,
          signal,
        });
        if (r.code !== 0) throw cliError("claude", r);
        return parseClaudeEnvelope(r.stdout);
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
        const answer = await readFile(outFile, "utf8")
          .then((s) => s.trim())
          .catch(() => "");
        if (answer) return { text: answer };
        if (r.code !== 0) throw cliError("codex", r);
        return { text: r.stdout.trim() };
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
      return { text: r.stdout.replace(/^Loaded cached credentials\.?\s*/i, "").trim() };
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
      return { text: r.stdout.trim() };
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
  const { text } = await cliChat(id, prompt, opts.signal, { tools: false });
  return parseLooseJSON(text);
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
 * LangGraph checkpointer now (cli-model.ts routes CLI turns through the same
 * graph as Ollama ones) — this only bounds how much of it one CLI invocation
 * re-reads.
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
