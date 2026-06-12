/**
 * The concierge as a LangGraph StateGraph:
 *
 *            ┌──────────── tool_calls ────────────┐
 *            ▼                                    │
 *   START → agent ── no tool_calls → END          │
 *            ▲                                    ▼
 *            └── rounds < MAX ────────────────── tools
 *                                                 │ rounds ≥ MAX
 *                                                 ▼
 *                                             finalize → END
 *
 * - `agent` calls ChatOllama with the toolbox bound; the system prompt is
 *   rebuilt every request so the event digest and clock stay fresh, and is
 *   never persisted into thread state.
 * - `tools` executes the model's tool calls, streaming start/done frames to
 *   the browser via the custom-stream writer (UI tools additionally emit
 *   "action" frames from inside the tool, see tools.ts).
 * - `finalize` answers without tools once the per-turn tool budget is spent,
 *   so a looping model can't spin forever.
 *
 * Conversation memory is a LangGraph checkpointer keyed by thread_id: the
 * client sends only the new user message and the graph replays the rest.
 * MemorySaver is deliberate — chats are ephemeral by design; restart the
 * server and threads reset while calendars/interests persist in Postgres.
 */
import {
  isAIMessage,
  isHumanMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import type { ToolCall } from "@langchain/core/messages/tool";
import {
  END,
  MemorySaver,
  MessagesAnnotation,
  START,
  StateGraph,
  type LangGraphRunnableConfig,
} from "@langchain/langgraph";
import { ChatOllama } from "@langchain/ollama";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { buildSystemPrompt, type AgentCtx, type ChatContext } from "./context.js";
import { makeTools, toolDetail, toolLabel } from "./tools.js";

export const MAX_TOOL_ROUNDS = 6;

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

type State = typeof MessagesAnnotation.State;

export interface GraphDeps {
  ctx: AgentCtx;
  chat: ChatContext;
  baseUrl: string;
  model: string;
  toolsOk: boolean;
}

/** Tool rounds the model has taken since the user last spoke. */
function toolRoundsThisTurn(messages: BaseMessage[]): number {
  let rounds = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (isHumanMessage(m)) break;
    if (isAIMessage(m) && m.tool_calls?.length) rounds++;
  }
  return rounds;
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
    return { messages: results };
  }

  function routeAfterAgent(state: State): "tools" | typeof END {
    const last = state.messages[state.messages.length - 1];
    return isAIMessage(last) && last.tool_calls?.length ? "tools" : END;
  }

  function routeAfterTools(state: State): "agent" | "finalize" {
    return toolRoundsThisTurn(state.messages) >= MAX_TOOL_ROUNDS ? "finalize" : "agent";
  }

  return new StateGraph(MessagesAnnotation)
    .addNode("agent", agentNode)
    .addNode("tools", toolsNode)
    .addNode("finalize", finalizeNode)
    .addEdge(START, "agent")
    .addConditionalEdges("agent", routeAfterAgent, ["tools", END])
    .addConditionalEdges("tools", routeAfterTools, ["agent", "finalize"])
    .addEdge("finalize", END)
    .compile({ checkpointer });
}
