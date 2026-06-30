/**
 * The concierge as a LangGraph StateGraph:
 *
 *            ┌──────────── tool_calls ────────────┐
 *            ▼                                    │
 *   START → agent ── no tool_calls → END          │
 *            ▲                                    ▼
 *            └── toolRounds < MAX ─────────────── tools
 *                                                 │ toolRounds ≥ MAX
 *                                                 ▼
 *                                             finalize → END
 *
 * State is a LangGraph `StateSchema` (Standard Schema, so plain Zod 4):
 * - `messages` — the running transcript (`MessagesValue` reducer).
 * - `toolRounds` — a `ReducedValue` counter the tools node increments; each
 *   user turn resets it via `Overwrite` (see `turnInput`), so routing reads a
 *   typed channel instead of re-scanning message history every step.
 *
 * Nodes:
 * - `agent` calls ChatOllama with the toolbox bound; the system prompt is
 *   rebuilt every request so the event digest and clock stay fresh, and is
 *   never persisted into thread state.
 * - `tools` executes the model's tool calls, streaming start/done frames to
 *   the browser via the custom-stream writer (UI tools additionally emit
 *   "action" frames from inside the tool, see tools.ts).
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
 *   it would re-emit UI action frames (duplicate confirm cards).
 *
 * Conversation memory is a LangGraph checkpointer keyed by thread_id: the
 * client sends only the new user message and the graph replays the rest.
 * MemorySaver is deliberate — chats are ephemeral by design; restart the
 * server and threads reset while calendars/interests persist in Postgres.
 */
import {
  isAIMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import type { ToolCall } from "@langchain/core/messages/tool";
import {
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
});

type State = typeof AgentState.State;

/**
 * The per-turn graph input: the new (or reseeded) messages, plus an
 * `Overwrite` that bypasses the sum reducer to zero the tool budget — a new
 * user turn starts with a full budget without replaying history.
 */
export function turnInput(messages: BaseMessage[]): typeof AgentState.Update {
  return { messages, toolRounds: new Overwrite(0) };
}

export interface GraphDeps {
  ctx: AgentCtx;
  chat: ChatContext;
  baseUrl: string;
  model: string;
  toolsOk: boolean;
}

/** Trailing window that never starts on an orphaned tool result. */
function windowed(messages: BaseMessage[]): BaseMessage[] {
  if (messages.length <= HISTORY_WINDOW) return messages;
  const recent = [...messages.slice(-HISTORY_WINDOW)];
  while (recent.length && recent[0].getType() === "tool") recent.shift();
  return recent;
}

export function buildAgentGraph(deps: GraphDeps) {
  const { ctx, chat, baseUrl, model, toolsOk } = deps;
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

  function routeAfterAgent(state: State): "tools" | typeof END {
    const last = state.messages[state.messages.length - 1];
    return isAIMessage(last) && last.tool_calls?.length ? "tools" : END;
  }

  function routeAfterTools(state: State): "agent" | "finalize" {
    return state.toolRounds >= MAX_TOOL_ROUNDS ? "finalize" : "agent";
  }

  const modelNodePolicy = {
    retryPolicy: modelRetry,
    timeout: { idleTimeout: MODEL_IDLE_TIMEOUT_MS },
  };

  return new StateGraph(AgentState)
    .addNode("agent", agentNode, modelNodePolicy)
    // No retry/timeout here: tools stream UI frames as they run, so a re-run
    // would duplicate them, and each call already catches its own failures.
    .addNode("tools", toolsNode)
    .addNode("finalize", finalizeNode, modelNodePolicy)
    .addEdge(START, "agent")
    .addConditionalEdges("agent", routeAfterAgent, ["tools", END])
    .addConditionalEdges("tools", routeAfterTools, ["agent", "finalize"])
    .addEdge("finalize", END)
    .compile({ checkpointer });
}
