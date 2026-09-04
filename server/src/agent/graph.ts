/**
 * The concierge as a LangGraph StateGraph, with the guardrails inside it:
 *
 *   START → input_rail ─ blocked ───────────────────────────────→ END
 *              │ clean
 *              ▼          ┌───────── tool_calls ───────┐
 *           recall        │                            │
 *              ▼          │                            │
 *            agent ───────┴─ no tool_calls ────────────┴───────→ END
 *              ▲                                       │
 *              │                                       ▼
 *              └── toolRounds < MAX ── content_rail ── tools
 *                                          │ toolRounds ≥ MAX
 *                                          ▼
 *                                      finalize → END
 *
 * The rails used to be `if` statements in the HTTP handler and inside two
 * tools. Moving them into the graph buys three things: they show up in
 * traces as nodes with inputs and outputs, a blocked turn is a routing
 * decision rather than an early `return`, and — most of the value —
 * every web-facing tool is covered by one rail instead of each tool
 * remembering to call the classifier itself. The next tool that fetches
 * something is protected by existing, not by someone noticing.
 *
 * The third rail, the deterministic persona scrubber on the answer, is not a
 * node but lives inside `invokeModel`: every model call the graph makes is
 * streamed through it, a trip aborts the model mid-stream, and the refusal
 * that replaces the answer is what the graph records. So every consumer of
 * the graph (the chat bridge, the red-team bridge, a test) gets the same
 * output rail without applying it by hand, and the HTTP layer reads a
 * `guardrail` frame like any other instead of sniffing the stream.
 *
 * The two rails keep untrusted text out of state in deliberately different
 * ways, because they are defending different things:
 *
 *  - `input_rail` reads the turn from `deps.userText` — a closure, not a
 *    state channel — and only promotes it into `messages` once it is clean.
 *    A flagged message therefore never enters the checkpointer at all, so it
 *    cannot poison the history later turns replay. The closure matters more
 *    now that the checkpointer is durable: a `pending` channel would land the
 *    unvetted text in Postgres for one superstep before the rail cleared it.
 *  - `content_rail` rewrites the tool results in place (same message id, which
 *    the messages reducer treats as a replacement). Tool output does reach
 *    `messages` for one superstep before the rail sees it, which is fine: the
 *    rail runs before the `agent` node does, so the model never reads
 *    unvetted text, and tool results are per-turn scratch rather than the
 *    durable history the input rail is protecting.
 *
 * State is a LangGraph `StateSchema` (Standard Schema, so plain Zod 4):
 * - `messages` — the running transcript (`MessagesValue` reducer).
 * - `toolRounds` — a `ReducedValue` counter the tools node increments; each
 *   user turn resets it via `Overwrite` (see `turnInput`), so routing reads a
 *   typed channel instead of re-scanning message history every step.
 * - `summary` / `summarized` — the running summary of turns that have scrolled
 *   out of the history window, and how many messages it covers.
 *
 * Nodes:
 * - `input_rail` classifies the user's turn (see guardrails.ts) and routes.
 * - `recall` folds turns that outgrew HISTORY_WINDOW into a running summary
 *   (a small extra generation, at most once per SUMMARY_STRIDE turns), so a
 *   long conversation loses its wording but not its facts. Best-effort: any
 *   failure skips the fold and the turn proceeds.
 * - `agent` calls the model with the toolbox bound; the system prompt is
 *   rebuilt every request so the event digest and clock stay fresh, and is
 *   never persisted into thread state. The model is ChatOllama, or — when a
 *   CLI provider is selected — CliChatModel, which shells out to Claude Code /
 *   Codex / Gemini / Copilot but streams through the same graph, so every
 *   provider gets the same rails, memory, and traces.
 * - `tools` executes the model's tool calls, streaming start/done frames to
 *   the browser via the custom-stream writer (UI tools additionally emit
 *   "action" frames from inside the tool, see tools.ts).
 * - `content_rail` scans the untrusted parts of those tool results.
 * - `finalize` answers without tools once the per-turn tool budget is spent,
 *   so a looping model can't spin forever.
 *
 * Node policies (model nodes only):
 * - `timeout.idleTimeout` — token callbacks refresh the idle timer, so long
 *   answers stream freely while a stalled Ollama generation fails in ~45s
 *   instead of eating the whole 120s HTTP deadline. CLI turns get a longer
 *   leash: their tool phases (MCP calls inside the CLI process) are silent.
 * - `retryPolicy.retryOn` — retries connection-establishment failures only.
 *   Those happen before the first token, so a retry can't duplicate streamed
 *   text; mid-stream failures (ECONNRESET, idle timeout) are deliberately not
 *   retried for the same reason. CLI models have no retry at all (a re-run
 *   spends real subscription tokens), and neither do the tools node (a re-run
 *   would re-emit UI action frames) or the rails — a retried scan would
 *   record the same decision twice and double-count it in the distribution.
 *
 * Conversation memory is a LangGraph checkpointer keyed by thread_id: the
 * client sends only the new user message and the graph replays the rest.
 * The checkpointer is durable (SupabaseSaver — see checkpointer.ts), so a
 * server restart keeps every thread's memory. There is no second copy to
 * reseed from: chat_messages is the transcript a person reads, the
 * checkpointer is the memory the graph uses.
 */
import {
  AIMessage,
  AIMessageChunk,
  HumanMessage,
  isAIMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import type { ToolCall } from "@langchain/core/messages/tool";
import { dispatchCustomEvent } from "@langchain/core/callbacks/dispatch";
import type { BaseLanguageModelInput } from "@langchain/core/language_models/base";
import type { Runnable } from "@langchain/core/runnables";
import { concat } from "@langchain/core/utils/stream";
import {
  Command,
  END,
  MemorySaver,
  MessagesValue,
  Overwrite,
  ReducedValue,
  START,
  StateGraph,
  StateSchema,
  type LangGraphRunnableConfig,
  type RetryPolicy,
} from "@langchain/langgraph";
import { ChatOllama } from "@langchain/ollama";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { z } from "zod";
import { llmPolicy } from "../budget.js";
import { SupabaseSaver } from "../checkpointer.js";
import { thinkFlagRejected } from "../ollama.js";
import type { ChatEffort, CliProviderId } from "../types.js";
import { CliChatModel } from "./cli-model.js";
import { buildSystemPrompt, type AgentCtx, type ChatContext } from "./context.js";
import { toolDetail, toolLabel } from "./contracts.js";
import {
  inputRefusalMessage,
  personaGuard,
  personaRefusalMessage,
  scanText,
  type ScanOptions,
} from "./guardrails.js";
import { emit, makeTools } from "./tools.js";

const MAX_TOOL_ROUNDS = 6;

/** How many out-of-window messages accumulate before the recall node folds
 *  them into the running summary. Bounds the extra generation to at most one
 *  per few turns instead of one per turn. */
export const SUMMARY_STRIDE = 8;

/** The fold itself is bounded: a summary that takes half the turn budget is
 *  worse than a lost detail. On abort the fold is skipped, never the turn. */
const SUMMARY_TIMEOUT_MS = 25_000;

/**
 * Connection-establishment failures only (Ollama restarting, socket refused).
 * These surface before any token streams, so retrying is invisible to the
 * browser. Mid-stream errors must not match — see the header comment. How
 * many attempts comes from the one LLM policy in budget.ts.
 */
const modelRetry: RetryPolicy = {
  maxAttempts: 1 + llmPolicy("ollama").retries,
  initialInterval: llmPolicy("ollama").retryDelayMs,
  retryOn: (err) => /fetch failed|ECONNREFUSED|EAI_AGAIN/i.test(String(err)),
};

/**
 * Strips <think>…</think> spans from streamed text, holding back partial tags
 * that split across chunk boundaries. Some models emit these even with the
 * thinking flag off.
 */
export function thinkStripper(): (chunk: string) => string {
  let inThink = false;
  let pending = "";
  const partialSuffix = (s: string, tag: string): string => {
    for (let n = Math.min(s.length, tag.length - 1); n > 0; n--) {
      if (s.endsWith(tag.slice(0, n))) return tag.slice(0, n);
    }
    return "";
  };
  return (chunk) => {
    let text = pending + chunk;
    pending = "";
    let out = "";
    while (text) {
      if (inThink) {
        const close = text.indexOf("</think>");
        if (close >= 0) {
          text = text.slice(close + 8);
          inThink = false;
          continue;
        }
        pending = partialSuffix(text, "</think>");
        text = "";
      } else {
        const open = text.indexOf("<think>");
        if (open >= 0) {
          out += text.slice(0, open);
          text = text.slice(open + 7);
          inThink = true;
          continue;
        }
        const tail = partialSuffix(text, "<think>");
        out += text.slice(0, text.length - tail.length);
        pending = tail;
        text = "";
      }
    }
    return out;
  };
}

/** How much thread history the model sees; older turns stay checkpointed. */
export const HISTORY_WINDOW = 24;

/** Durable: threads survive restarts. Fails soft to per-process memory. */
const checkpointer = new SupabaseSaver();

/** Whether the durable checkpointer holds this thread, i.e. it has had a turn before. */
export async function hasCheckpoint(threadId: string): Promise<boolean> {
  const tuple = await checkpointer.getTuple({ configurable: { thread_id: threadId } });
  return !!tuple;
}

/** Deleting a thread deletes its graph state too, not just its transcript. */
export async function forgetThread(threadId: string): Promise<void> {
  await checkpointer.deleteThread(threadId);
}

const AgentState = new StateSchema({
  messages: MessagesValue,
  /** Tool rounds spent on the current turn; summed by the tools node. */
  toolRounds: new ReducedValue(z.number().default(0), {
    reducer: (total, next) => total + next,
  }),
  /** Running summary of turns that scrolled out of HISTORY_WINDOW. */
  summary: new ReducedValue(z.string().default(""), {
    reducer: (_prev: string, next: string) => next,
  }),
  /** How many leading messages `summary` covers. */
  summarized: new ReducedValue(z.number().default(0), {
    reducer: (_prev: number, next: number) => next,
  }),
  /** The input rail refused this turn. Reset per turn; read by the bridges. */
  inputBlocked: new ReducedValue(z.boolean().default(false), {
    reducer: (_prev: boolean, next: boolean) => next,
  }),
  /** The persona rail replaced this turn's answer. Reset per turn. */
  outputTripped: new ReducedValue(z.boolean().default(false), {
    reducer: (_prev: boolean, next: boolean) => next,
  }),
});

type State = typeof AgentState.State;

/**
 * The per-turn graph input: `Overwrite`s that bypass the reducers to zero the
 * tool budget and clear the rail flags, so a new user turn starts clean
 * without replaying history. `seed` exists for the red-team bridge, which
 * hands each synthetic turn its own history; the chat bridge passes nothing
 * because the checkpointer already holds the thread.
 *
 * The user's text is deliberately NOT part of the input: it rides in on
 * `GraphDeps.userText` and only the input rail may write it into `messages`.
 * See the header — that is what keeps a flagged message out of the durable
 * checkpointer.
 */
export function turnInput(seed: BaseMessage[] = []): typeof AgentState.Update {
  return {
    messages: seed,
    toolRounds: new Overwrite(0),
    inputBlocked: new Overwrite(false),
    outputTripped: new Overwrite(false),
  };
}

export interface GraphDeps {
  ctx: AgentCtx;
  chat: ChatContext;
  baseUrl: string;
  model: string;
  toolsOk: boolean;
  /** Named in the input rail's refusal. */
  city: string;
  /** The new user turn, unvetted. Only the input rail promotes it to state. */
  userText: string;
  /**
   * Compile with a throwaway in-memory checkpointer instead of the durable
   * one. The red-team bridge sets this: synthetic conversations must never
   * land in the same Postgres table as real ones.
   */
  ephemeral?: boolean;
  /** Set to route the turn through a subscription CLI instead of Ollama. */
  provider?: CliProviderId;
  /** Per-turn Claude Code overrides (ignored by the other CLIs). */
  cliModel?: string;
  cliEffort?: ChatEffort;
  /**
   * Stamped onto every telemetry row this turn writes. `record: false` opts
   * the whole turn out, which the red-team simulation uses so its synthetic
   * traffic never enters the distribution the panel reports on.
   */
  telemetry?: Pick<ScanOptions, "surface" | "threadId" | "userId" | "provider" | "record">;
}

/** Trailing window that never starts on an orphaned tool result. */
export function windowed(messages: BaseMessage[]): BaseMessage[] {
  if (messages.length <= HISTORY_WINDOW) return messages;
  const recent = [...messages.slice(-HISTORY_WINDOW)];
  while (recent.length && recent[0].getType() === "tool") recent.shift();
  return recent;
}

/**
 * How many messages have scrolled out of the window since the last fold, or
 * null when fewer than SUMMARY_STRIDE have, so the recall node folds at most
 * once every few turns rather than every turn.
 */
export function recallOverflow(messageCount: number, summarized: number): number | null {
  const overflow = messageCount - HISTORY_WINDOW;
  return overflow - summarized >= SUMMARY_STRIDE ? overflow : null;
}

/** After the model: tools when it asked for any, otherwise the turn is over. */
export function routeAfterAgent(state: Pick<State, "messages">): "tools" | typeof END {
  const last = state.messages[state.messages.length - 1];
  if (!last) return END;
  return isAIMessage(last) && last.tool_calls?.length ? "tools" : END;
}

/** After the content rail: back to the model, or to the no-tools finalize once the budget is spent. */
export function routeAfterRail(state: Pick<State, "toolRounds">): "agent" | "finalize" {
  return state.toolRounds >= MAX_TOOL_ROUNDS ? "finalize" : "agent";
}

// ---------------------------------------------------------------------------
// Content rail — what counts as untrusted in each tool's result
// ---------------------------------------------------------------------------

/**
 * Only the fields a remote server actually wrote. The tool results are our own
 * JSON envelopes around someone else's text, and scanning the envelope would
 * both waste a classification and risk flagging our own wording — the note
 * this very rail writes says "prompt injection" in it.
 *
 * A tool absent from here is not scanned, which is correct: `search_events`
 * returns rows from our own database, and running a jailbreak classifier over
 * them would eventually refuse to show someone an event because of its title.
 */
const WEB_FACING_TOOLS = new Set(["search_web", "read_page"]);

export interface RailedResult {
  /** The rewritten payload, or null when nothing needed changing. */
  content: string | null;
  /** What the rail did, for the trace and the UI frame. */
  dropped: number;
  blocked: boolean;
  topScore: number;
}

/**
 * Exported for the guardrails eval suite. The field selection below is the
 * part with actual judgement in it — which keys a remote server wrote versus
 * which ones we did — and it is worth asserting directly rather than only
 * through a live model run.
 */
export async function railToolResult(
  name: string,
  raw: string,
  scan: (text: string) => Promise<{ blocked: boolean; score: number }>,
): Promise<RailedResult> {
  const nothing: RailedResult = { content: null, dropped: 0, blocked: false, topScore: 0 };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // A tool that did not return JSON is a bug elsewhere; the rail is not the
    // place to discover it, and refusing the result would hide it further.
    return nothing;
  }
  if (!parsed || typeof parsed !== "object") return nothing;

  if (name === "search_web" && Array.isArray((parsed as { results?: unknown }).results)) {
    const payload = parsed as { results: { title?: string; snippet?: string }[]; count?: number };
    const verdicts = await Promise.all(
      payload.results.map((hit) => scan(`${hit.title ?? ""}\n${hit.snippet ?? ""}`)),
    );
    const kept = payload.results.filter((_, i) => !verdicts[i].blocked);
    const dropped = payload.results.length - kept.length;
    const topScore = Math.max(0, ...verdicts.map((v) => v.score));
    if (!dropped) return { ...nothing, topScore };
    return {
      content: JSON.stringify({
        ...payload,
        count: kept.length,
        results: kept,
        note: `${dropped} result(s) withheld by guardrails (suspected prompt injection)`,
      }),
      dropped,
      blocked: false,
      topScore,
    };
  }

  if (name === "read_page" && typeof (parsed as { text?: unknown }).text === "string") {
    const verdict = await scan((parsed as { text: string }).text);
    if (!verdict.blocked) return { ...nothing, topScore: verdict.score };
    return {
      content: JSON.stringify({
        error: `page withheld by guardrails — its content looks like a prompt-injection attempt (score ${verdict.score.toFixed(2)}). Do not retry this url.`,
      }),
      dropped: 1,
      blocked: true,
      topScore: verdict.score,
    };
  }

  return nothing;
}

// ---------------------------------------------------------------------------

export function buildAgentGraph(deps: GraphDeps) {
  const { ctx, chat, baseUrl, model, toolsOk, city, telemetry } = deps;
  const system = new SystemMessage(buildSystemPrompt(ctx, chat, toolsOk));

  // A CLI provider replaces the model, not the graph: rails, memory, and
  // traces stay identical. Its in-CLI tool calls surface as frames via
  // `frames`, pointed at the current run's writer inside invokeModel.
  const cli = deps.provider
    ? new CliChatModel({ provider: deps.provider, model: deps.cliModel, effort: deps.cliEffort })
    : null;

  // Built only for Ollama turns. A CLI turn never binds these tools (the CLI
  // brings its own through MCP) and never calls ChatOllama, so constructing
  // twelve LangChain tools and two model clients for it was pure overhead.
  const tools = cli ? [] : makeTools(ctx, chat);
  const toolsByName = new Map<string, StructuredToolInterface>(
    tools.map((t) => [t.name, t as StructuredToolInterface]),
  );
  const opts = { baseUrl, model, temperature: 0.3, numCtx: 16384 };
  // Same dance as ollama.ts chatJSON: ask for no thinking, but fall back for
  // models that reject the flag outright (thinkFlagRejected is the one test).
  const llm = cli ? null : new ChatOllama({ ...opts, think: false });
  const llmNoFlag = cli ? null : new ChatOllama(opts);
  const agentLlm = llm && toolsOk ? llm.bindTools(tools) : llm;
  const agentLlmNoFlag = llmNoFlag && toolsOk ? llmNoFlag.bindTools(tools) : llmNoFlag;

  type Model = Runnable<BaseLanguageModelInput, AIMessageChunk>;
  const modelName = deps.provider ?? model;

  /**
   * One model call, streamed through the output rail. Tokens reach the
   * browser (and the transcript) only after the persona guard has cleared
   * them; a trip aborts the model mid-stream, tells the client with a
   * guardrail frame, a notice and a replace, and hands back the refusal as the
   * message the graph records. The think-flag fallback lives here too: the
   * flag is rejected before any token streams, so the retry cannot duplicate
   * output, and nothing after the first token is ever retried.
   */
  async function invokeModel(
    messages: BaseMessage[],
    config: LangGraphRunnableConfig,
    withTools: boolean,
  ): Promise<{ message: AIMessage; tripped: boolean }> {
    let primary: Model;
    let fallback: Model | null;
    if (cli) {
      cli.frames = (frame) => emit(config, frame);
      primary = cli;
      fallback = null;
    } else {
      primary = (withTools ? agentLlm : llm) as Model;
      fallback = (withTools ? agentLlmNoFlag : llmNoFlag) as Model;
    }
    const guard = personaGuard({ modelName, telemetry });
    const strip = thinkStripper();
    const ac = new AbortController();
    const signal = config.signal ? AbortSignal.any([config.signal, ac.signal]) : ac.signal;

    let text = "";
    let final: AIMessageChunk | null = null;
    /** Stream one runnable through the guard; returns the accumulated chunk. */
    const consume = async (runnable: Model): Promise<AIMessageChunk | null> => {
      let acc: AIMessageChunk | null = null;
      const stream = await runnable.stream(messages, { ...config, signal });
      for await (const chunk of stream) {
        acc = acc ? concat(acc, chunk) : chunk;
        const raw = typeof chunk.content === "string" ? chunk.content : "";
        if (!raw) continue;
        const safe = guard.push(strip(raw));
        if (guard.tripped) {
          ac.abort(); // stop the local GPU: the rest of this answer is never shown
          return acc;
        }
        if (safe) {
          text += safe;
          emit(config, { type: "delta", text: safe });
        }
      }
      return acc;
    };
    try {
      final = await consume(primary);
    } catch (err) {
      if (guard.tripped) {
        // The abort above surfaces here as an error; the trip is the answer.
      } else if (fallback && !text && thinkFlagRejected(err)) {
        final = await consume(fallback);
      } else {
        throw err;
      }
    }
    if (!guard.tripped) {
      const rest = guard.flush();
      if (rest && !guard.tripped) {
        text += rest;
        emit(config, { type: "delta", text: rest });
      }
    }
    if (guard.tripped) {
      emit(config, {
        type: "guardrail",
        rail: "output",
        blocked: true,
        ...(guard.pattern && { pattern: guard.pattern }),
      });
      emit(config, {
        type: "notice",
        code: "guardrails",
        message:
          "The reply broke character (model identity leak) and was replaced by the persona rail.",
      });
      const refusal = personaRefusalMessage(city);
      emit(config, { type: "replace", text: refusal });
      return { message: new AIMessage(refusal), tripped: true };
    }
    return {
      message: new AIMessage({
        content: text,
        tool_calls: final?.tool_calls ?? [],
        ...(final?.id && { id: final.id }),
      }),
      tripped: false,
    };
  }

  /**
   * Input rail. Promotes a clean turn into `messages` and routes onward;
   * on a flagged turn it writes the refusal straight to the client and ends
   * the run without the text ever reaching the transcript.
   */
  async function inputRailNode(_state: State, config: LangGraphRunnableConfig) {
    const text = deps.userText.trim();
    // A replayed run with nothing new to vet.
    if (!text) return new Command({ goto: "recall" });

    const verdict = await scanText(text, { rail: "input", ...telemetry });

    // Lands in the LangSmith trace alongside the node's own I/O, so a run can
    // be read as "what did the rail think" rather than inferred from whether
    // the agent node ran.
    await dispatchCustomEvent(
      "guardrail",
      {
        rail: "input",
        score: Number(verdict.score.toFixed(4)),
        threshold: verdict.threshold,
        mode: verdict.mode,
        blocked: verdict.blocked,
        available: verdict.available,
      },
      config,
    ).catch(() => {
      /* tracing must never break a turn */
    });

    if (!verdict.blocked) {
      return new Command({
        goto: "recall",
        update: { messages: [new HumanMessage(text)] },
      });
    }

    // Two frames, and they are not redundant. `guardrail` is the machine-
    // readable one the HTTP layer keys on to keep a blocked turn out of the
    // persisted transcript; `notice` is the sentence a person reads. The
    // dispatchCustomEvent above reaches LangSmith but NOT this stream, so it
    // cannot stand in for either.
    emit(config, {
      type: "guardrail",
      rail: "input",
      blocked: true,
      score: Number(verdict.score.toFixed(4)),
      threshold: verdict.threshold,
    });
    emit(config, {
      type: "notice",
      code: "guardrails",
      message: `Blocked by the local safety classifier (score ${verdict.score.toFixed(2)}, threshold ${verdict.threshold.toFixed(2)}).`,
    });
    const refusal = inputRefusalMessage(city);
    emit(config, { type: "delta", text: refusal });
    // The refusal is the assistant's turn as far as the transcript is
    // concerned; the message that provoked it is deliberately not recorded.
    return new Command({
      goto: END,
      update: { messages: [new AIMessage(refusal)], inputBlocked: true },
    });
  }

  /**
   * Recall. When more than SUMMARY_STRIDE messages have scrolled out of the
   * history window since the last fold, compress them into the running
   * summary so windowed() stops meaning "forgotten". Skipped for CLI
   * providers — a hidden generation there spends real subscription tokens —
   * and skipped on any failure: memory compression is a nicety, the turn is
   * not.
   */
  async function recallNode(state: State, config: LangGraphRunnableConfig) {
    if (!llm) return {};
    const overflow = recallOverflow(state.messages.length, state.summarized);
    if (overflow === null) return {};
    const fold = state.messages
      .slice(state.summarized, overflow)
      .map((m) => {
        const role =
          m.getType() === "human" ? "Visitor" : m.getType() === "ai" ? "Grapevine" : "tool";
        const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
        return `${role}: ${text.slice(0, 600)}`;
      })
      .join("\n");
    try {
      const signals = [AbortSignal.timeout(SUMMARY_TIMEOUT_MS)];
      if (config.signal) signals.push(config.signal);
      const res = await llm.invoke(
        [
          new SystemMessage(
            "You maintain the running memory of a long conversation between a visitor and Grapevine, a local events concierge. Fold the new exchanges below into the existing summary. Keep every durable fact: names of events, venues, dates, times, prices, the visitor's stated tastes, constraints, and decisions. Drop pleasantries and wording. Answer with the updated summary only, 200 words or fewer.",
          ),
          new HumanMessage(
            `Existing summary:\n${state.summary || "(none yet)"}\n\nNew exchanges to fold in:\n${fold}`,
          ),
        ],
        { signal: AbortSignal.any(signals) },
      );
      const summary = typeof res.content === "string" ? res.content.trim() : "";
      if (!summary) return {};
      return { summary: summary.slice(0, 2_000), summarized: overflow };
    } catch {
      return {}; // next turn's overflow will be bigger; it retries naturally
    }
  }

  /** The out-of-window memory, when there is any, injected after the system prompt. */
  function recallMessages(state: State): SystemMessage[] {
    return state.summary
      ? [new SystemMessage(`Earlier in this conversation (running summary): ${state.summary}`)]
      : [];
  }

  async function agentNode(state: State, config: LangGraphRunnableConfig) {
    const { message, tripped } = await invokeModel(
      [system, ...recallMessages(state), ...windowed(state.messages)],
      config,
      true,
    );
    return { messages: [message], ...(tripped && { outputTripped: true }) };
  }

  /** No tools, budget-spent nudge appended — the model must answer now. */
  async function finalizeNode(state: State, config: LangGraphRunnableConfig) {
    const nudge = new SystemMessage(
      "Tool limit reached — answer the user now using only what you've already gathered.",
    );
    const { message, tripped } = await invokeModel(
      [system, ...recallMessages(state), ...windowed(state.messages), nudge],
      config,
      false,
    );
    return { messages: [message], ...(tripped && { outputTripped: true }) };
  }

  async function toolsNode(state: State, config: LangGraphRunnableConfig) {
    const last = state.messages[state.messages.length - 1];
    const calls: ToolCall[] = (isAIMessage(last) ? last.tool_calls : undefined) ?? [];
    const results: ToolMessage[] = [];
    for (const call of calls) {
      const label = toolLabel(call.name, call.args);
      emit(config, { type: "tool", name: call.name, label, state: "start" });
      let message: ToolMessage;
      const t = toolsByName.get(call.name);
      if (!t) {
        message = new ToolMessage({
          tool_call_id: call.id ?? "",
          name: call.name,
          content: JSON.stringify({ error: `unknown tool ${call.name}` }),
        });
      } else {
        try {
          message = (await t.invoke(call, config)) as ToolMessage;
        } catch (err) {
          // Bad args or a downstream failure — hand the error to the model
          // as a tool result so it can route around it.
          message = new ToolMessage({
            tool_call_id: call.id ?? "",
            name: call.name,
            content: JSON.stringify({ error: String(err).slice(0, 200) }),
          });
        }
      }
      const detail = toolDetail(call.name, message.content);
      emit(config, {
        type: "tool",
        name: call.name,
        label,
        state: "done",
        ...(detail && { detail }),
      });
      results.push(message);
    }
    return { messages: results, toolRounds: 1 };
  }

  /**
   * Content rail. Scans the untrusted parts of the results the tools node just
   * produced and replaces any that need it — same message id, which the
   * messages reducer treats as a replacement rather than an append.
   *
   * This is the indirect-injection path: text on a page the agent chose to
   * fetch is data, and an instruction hidden in that data never touches the
   * chat box, so the input rail would never see it.
   */
  async function contentRailNode(state: State, config: LangGraphRunnableConfig) {
    // The trailing run of tool messages is exactly what the tools node just
    // appended; anything earlier has already been through here.
    const round: ToolMessage[] = [];
    for (let i = state.messages.length - 1; i >= 0; i--) {
      const m = state.messages[i];
      if (m.getType() !== "tool") break;
      round.unshift(m as ToolMessage);
    }

    const scan = async (text: string) => {
      const v = await scanText(text, { rail: "content", ...telemetry });
      return { blocked: v.blocked, score: v.score };
    };

    const replacements: ToolMessage[] = [];
    let dropped = 0;
    let topScore = 0;

    await Promise.all(
      round.map(async (message) => {
        const name = message.name ?? "";
        if (!WEB_FACING_TOOLS.has(name)) return;
        const raw = typeof message.content === "string" ? message.content : "";
        if (!raw) return;
        const result = await railToolResult(name, raw, scan);
        topScore = Math.max(topScore, result.topScore);
        dropped += result.dropped;
        if (result.content === null) return;
        replacements.push(
          new ToolMessage({
            // Same id: a replacement, not a second copy of the result.
            id: message.id,
            tool_call_id: message.tool_call_id,
            name,
            content: result.content,
          }),
        );
      }),
    );

    if (round.some((m) => WEB_FACING_TOOLS.has(m.name ?? ""))) {
      await dispatchCustomEvent(
        "guardrail",
        { rail: "content", scanned: round.length, dropped, topScore: Number(topScore.toFixed(4)) },
        config,
      ).catch(() => {
        /* tracing must never break a turn */
      });
    }

    if (dropped) {
      emit(config, {
        type: "notice",
        code: "guardrails",
        message:
          dropped === 1
            ? "One fetched page or result was withheld — its text reads like a prompt-injection attempt."
            : `${dropped} fetched results were withheld — their text reads like a prompt-injection attempt.`,
      });
    }

    return replacements.length ? { messages: replacements } : {};
  }

  // One policy per provider (budget.ts): CLI models get a longer idle leash
  // (their tool phases stream nothing) and no retry (a re-run spends real
  // subscription tokens on a duplicate turn).
  const policy = llmPolicy(deps.provider ?? "ollama");
  const modelNodePolicy = cli
    ? { timeout: { idleTimeout: policy.idleTimeoutMs } }
    : { retryPolicy: modelRetry, timeout: { idleTimeout: policy.idleTimeoutMs } };

  return (
    new StateGraph(AgentState)
      // No retry on the rails: a retried scan records the same decision twice,
      // and a distribution that double-counts its retries is worse than one
      // that misses them.
      .addNode("input_rail", inputRailNode, { ends: ["recall", END] })
      // Best-effort by construction (it catches everything), so no policies.
      .addNode("recall", recallNode)
      .addNode("agent", agentNode, modelNodePolicy)
      // No retry/timeout here: tools stream UI frames as they run, so a re-run
      // would duplicate them, and each call already catches its own failures.
      .addNode("tools", toolsNode)
      .addNode("content_rail", contentRailNode)
      .addNode("finalize", finalizeNode, modelNodePolicy)
      .addEdge(START, "input_rail")
      .addEdge("recall", "agent")
      .addConditionalEdges("agent", routeAfterAgent, ["tools", END])
      .addEdge("tools", "content_rail")
      .addConditionalEdges("content_rail", routeAfterRail, ["agent", "finalize"])
      .addEdge("finalize", END)
      .compile({ checkpointer: deps.ephemeral ? new MemorySaver() : checkpointer })
  );
}
