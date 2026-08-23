/**
 * The concierge as a LangGraph StateGraph, with the guardrails as nodes in it:
 *
 *   START → input_rail ─ blocked ──────────────────────────────→ END
 *              │ clean
 *              ▼          ┌──────── tool_calls ────────┐
 *            agent ───────┴─ no tool_calls ────────────┴──────→ END
 *              ▲                                       │
 *              │                                       ▼
 *              └── toolRounds < MAX ── content_rail ── tools
 *                                          │ toolRounds ≥ MAX
 *                                          ▼
 *                                      finalize → END
 *
 * The rails used to be `if` statements in the HTTP handler and inside two
 * tools. Moving them into the graph buys three things: they show up in
 * LangSmith traces as nodes with inputs and outputs, a blocked turn is a
 * routing decision rather than an early `return`, and — most of the value —
 * every web-facing tool is covered by one rail instead of each tool
 * remembering to call the classifier itself. The next tool that fetches
 * something is protected by existing, not by someone noticing.
 *
 * The two rails keep untrusted text out of state in deliberately different
 * ways, because they are defending different things:
 *
 *  - `input_rail` reads the turn from a `pending` channel and only promotes
 *    it into `messages` once it is clean. A flagged message therefore never
 *    enters the checkpointer at all, so it cannot poison the history that
 *    later turns replay. That property is the whole reason the channel exists.
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
 * - `pending` — the unvetted user turn, cleared by the input rail.
 *
 * Nodes:
 * - `input_rail` classifies the user's turn (see guardrails.ts) and routes.
 * - `agent` calls ChatOllama with the toolbox bound; the system prompt is
 *   rebuilt every request so the event digest and clock stay fresh, and is
 *   never persisted into thread state.
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
 *   instead of eating the whole 120s HTTP deadline.
 * - `retryPolicy.retryOn` — retries connection-establishment failures only.
 *   Those happen before the first token, so a retry can't duplicate streamed
 *   text; mid-stream failures (ECONNRESET, idle timeout) are deliberately not
 *   retried for the same reason. The tools node has no retry at all: re-running
 *   it would re-emit UI action frames (duplicate confirm cards). The rail
 *   nodes have none either — a retried scan would record the same decision
 *   twice and quietly double-count it in the distribution.
 *
 * Conversation memory is a LangGraph checkpointer keyed by thread_id: the
 * client sends only the new user message and the graph replays the rest.
 * MemorySaver is deliberate — chats are ephemeral by design; restart the
 * server and threads reset while calendars/interests persist in Postgres.
 */
import {
  AIMessage,
  HumanMessage,
  isAIMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import type { ToolCall } from "@langchain/core/messages/tool";
import { dispatchCustomEvent } from "@langchain/core/callbacks/dispatch";
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
import { buildSystemPrompt, type AgentCtx, type ChatContext } from "./context.js";
import { inputRefusalMessage, scanText, type ScanOptions } from "./guardrails.js";
import { makeTools, toolDetail, toolLabel } from "./tools.js";

export const MAX_TOOL_ROUNDS = 6;

/** A stalled generation fails here; a healthy stream refreshes the timer per token. */
const MODEL_IDLE_TIMEOUT_MS = 45_000;

/**
 * Connection-establishment failures only (Ollama restarting, socket refused).
 * These surface before any token streams, so retrying is invisible to the
 * browser. Mid-stream errors must not match — see the header comment.
 */
const modelRetry: RetryPolicy = {
  maxAttempts: 2,
  initialInterval: 500,
  retryOn: (err) => /fetch failed|ECONNREFUSED|EAI_AGAIN/i.test(String(err)),
};

/** How much thread history the model sees; older turns stay checkpointed. */
const HISTORY_WINDOW = 24;

/** Threads live for the process lifetime — ephemeral chat is a feature. */
const checkpointer = new MemorySaver();

/**
 * Whether the in-memory checkpointer still holds this thread. False after a
 * server restart — the caller then reseeds the graph from the persisted chat
 * history so a resumed conversation keeps its memory.
 */
export async function hasCheckpoint(threadId: string): Promise<boolean> {
  const tuple = await checkpointer.getTuple({ configurable: { thread_id: threadId } });
  return !!tuple;
}

const AgentState = new StateSchema({
  messages: MessagesValue,
  /** Tool rounds spent on the current turn; summed by the tools node. */
  toolRounds: new ReducedValue(z.number().default(0), {
    reducer: (total, next) => total + next,
  }),
  /**
   * The user's turn before the input rail has looked at it. Last write wins:
   * this is a per-turn hand-off between exactly two writers (the caller sets
   * it, the rail clears it), never something to accumulate.
   */
  pending: new ReducedValue(z.string().default(""), {
    reducer: (_prev: string, next: string) => next,
  }),
});

type State = typeof AgentState.State;

/**
 * The per-turn graph input: any replayed history, the new user text held
 * unvetted in `pending`, plus an `Overwrite` that bypasses the sum reducer to
 * zero the tool budget — a new user turn starts with a full budget without
 * replaying history.
 *
 * `text` goes into `pending` rather than into `messages` on purpose. See the
 * header: it is what keeps a flagged message out of the checkpointer.
 */
export function turnInput(text: string, seed: BaseMessage[] = []): typeof AgentState.Update {
  return { messages: seed, pending: text, toolRounds: new Overwrite(0) };
}

export interface GraphDeps {
  ctx: AgentCtx;
  chat: ChatContext;
  baseUrl: string;
  model: string;
  toolsOk: boolean;
  /** Named in the input rail's refusal. */
  city: string;
  /**
   * Stamped onto every telemetry row this turn writes. `record: false` opts
   * the whole turn out, which the red-team simulation uses so its synthetic
   * traffic never enters the distribution the panel reports on.
   */
  telemetry?: Pick<ScanOptions, "surface" | "threadId" | "userId" | "provider" | "record">;
}

/** Trailing window that never starts on an orphaned tool result. */
function windowed(messages: BaseMessage[]): BaseMessage[] {
  if (messages.length <= HISTORY_WINDOW) return messages;
  const recent = [...messages.slice(-HISTORY_WINDOW)];
  while (recent.length && recent[0].getType() === "tool") recent.shift();
  return recent;
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

  const tools = makeTools(ctx, chat);
  const toolsByName = new Map<string, StructuredToolInterface>(
    tools.map((t) => [t.name, t as StructuredToolInterface]),
  );

  const opts = { baseUrl, model, temperature: 0.3, numCtx: 16384 };
  // Same dance as ollama.ts chatJSON: ask for no thinking, but fall back for
  // models that reject the flag outright.
  const llm = new ChatOllama({ ...opts, think: false });
  const llmNoFlag = new ChatOllama(opts);
  const agentLlm = toolsOk ? llm.bindTools(tools) : llm;
  const agentLlmNoFlag = toolsOk ? llmNoFlag.bindTools(tools) : llmNoFlag;

  async function invokeModel(
    messages: BaseMessage[],
    config: LangGraphRunnableConfig,
    withTools: boolean,
  ) {
    const [primary, fallback] = withTools ? [agentLlm, agentLlmNoFlag] : [llm, llmNoFlag];
    try {
      return await primary.invoke(messages, config);
    } catch (err) {
      if (!/think/i.test(String(err))) throw err;
      return await fallback.invoke(messages, config);
    }
  }

  /**
   * Input rail. Promotes a clean turn into `messages` and routes to the agent;
   * on a flagged turn it writes the refusal straight to the client and ends
   * the run without the text ever reaching the transcript.
   */
  async function inputRailNode(state: State, config: LangGraphRunnableConfig) {
    const text = state.pending?.trim();
    // A resumed or replayed run with nothing pending: nothing to vet.
    if (!text) return new Command({ goto: "agent", update: { pending: "" } });

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
        goto: "agent",
        update: { messages: [new HumanMessage(text)], pending: "" },
      });
    }

    // Two frames, and they are not redundant. `guardrail` is the machine-
    // readable one the HTTP layer keys on to keep a blocked turn out of the
    // persisted transcript; `notice` is the sentence a person reads. The
    // dispatchCustomEvent above reaches LangSmith but NOT this stream, so it
    // cannot stand in for either.
    config.writer?.({
      type: "guardrail",
      rail: "input",
      blocked: true,
      score: Number(verdict.score.toFixed(4)),
      threshold: verdict.threshold,
    });
    config.writer?.({
      type: "notice",
      code: "guardrails",
      message: `Blocked by the local safety classifier (score ${verdict.score.toFixed(2)}, threshold ${verdict.threshold.toFixed(2)}).`,
    });
    const refusal = inputRefusalMessage(city);
    config.writer?.({ type: "delta", text: refusal });
    // The refusal is the assistant's turn as far as the transcript is
    // concerned; the message that provoked it is deliberately not recorded.
    return new Command({ goto: END, update: { messages: [new AIMessage(refusal)], pending: "" } });
  }

  async function agentNode(state: State, config: LangGraphRunnableConfig) {
    const res = await invokeModel([system, ...windowed(state.messages)], config, true);
    return { messages: [res] };
  }

  /** No tools, budget-spent nudge appended — the model must answer now. */
  async function finalizeNode(state: State, config: LangGraphRunnableConfig) {
    const nudge = new SystemMessage(
      "Tool limit reached — answer the user now using only what you've already gathered.",
    );
    const res = await invokeModel(
      [system, ...windowed(state.messages), nudge],
      config,
      false,
    );
    return { messages: [res] };
  }

  async function toolsNode(state: State, config: LangGraphRunnableConfig) {
    const last = state.messages[state.messages.length - 1];
    const calls: ToolCall[] = (isAIMessage(last) ? last.tool_calls : undefined) ?? [];
    const results: ToolMessage[] = [];
    for (const call of calls) {
      const label = toolLabel(call.name, call.args);
      config.writer?.({ type: "tool", name: call.name, label, state: "start" });
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
      config.writer?.({
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
      config.writer?.({
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

  function routeAfterAgent(state: State): "tools" | typeof END {
    const last = state.messages[state.messages.length - 1];
    return isAIMessage(last) && last.tool_calls?.length ? "tools" : END;
  }

  function routeAfterRail(state: State): "agent" | "finalize" {
    return state.toolRounds >= MAX_TOOL_ROUNDS ? "finalize" : "agent";
  }

  const modelNodePolicy = {
    retryPolicy: modelRetry,
    timeout: { idleTimeout: MODEL_IDLE_TIMEOUT_MS },
  };

  return new StateGraph(AgentState)
    // No retry on the rails: a retried scan records the same decision twice,
    // and a distribution that double-counts its retries is worse than one
    // that misses them.
    .addNode("input_rail", inputRailNode, { ends: ["agent", END] })
    .addNode("agent", agentNode, modelNodePolicy)
    // No retry/timeout here: tools stream UI frames as they run, so a re-run
    // would duplicate them, and each call already catches its own failures.
    .addNode("tools", toolsNode)
    .addNode("content_rail", contentRailNode)
    .addNode("finalize", finalizeNode, modelNodePolicy)
    .addEdge(START, "input_rail")
    .addConditionalEdges("agent", routeAfterAgent, ["tools", END])
    .addEdge("tools", "content_rail")
    .addConditionalEdges("content_rail", routeAfterRail, ["agent", "finalize"])
    .addEdge("finalize", END)
    .compile({ checkpointer });
}
