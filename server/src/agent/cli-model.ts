/**
 * The subscription CLI providers (Claude Code / Codex / Gemini / Copilot) as
 * a LangChain chat model, so a CLI turn runs through the same LangGraph as
 * the Ollama one: same input rail, same checkpointer, same persona guard,
 * same trace shape. Before this, the CLI path was a parallel copy of all of
 * that in the HTTP handler, which is exactly how a rail quietly stops
 * covering half the traffic.
 *
 * Streaming: cliChat reports text via events.onText (Claude Code only; the
 * other CLIs answer in one shot). _streamResponseChunks turns those callbacks
 * into chunks, so the graph's invokeModel can run every token through the
 * output rail as it arrives, the same way it does for Ollama. A CLI that
 * does not stream yields its whole answer as one chunk at the end.
 *
 * Tool calls: none are bound here. Claude Code brings its own toolbox (this
 * server's MCP endpoint) and runs those calls inside the CLI process; their
 * start/done events surface as UI frames through `frames`, which the agent
 * node points at the graph's custom-stream writer per turn.
 */
import type { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager";
import {
  BaseChatModel,
  type BaseChatModelCallOptions,
  type BaseChatModelParams,
} from "@langchain/core/language_models/chat_models";
import { AIMessage, AIMessageChunk, type BaseMessage } from "@langchain/core/messages";
import { ChatGenerationChunk, type ChatResult } from "@langchain/core/outputs";
import { buildCliPrompt, cliChat, cliSupportsTools, type CliProviderId } from "../providers.js";
import type { AgentFrame, ChatEffort } from "../types.js";

export interface CliChatModelFields extends BaseChatModelParams {
  provider: CliProviderId;
  /** Per-turn model override (Claude Code only). */
  model?: string;
  effort?: ChatEffort;
}

interface Exchange {
  user: string;
  assistant: string;
}

function text(m: BaseMessage): string {
  return typeof m.content === "string" ? m.content : JSON.stringify(m.content);
}

/**
 * The graph hands over [system…, older turns…, new human]. The CLIs want one
 * flat prompt: system text, user/assistant pairs, then the fresh message.
 * Unpaired tails (two humans in a row after an aborted stream) are skipped,
 * matching how the persisted history was replayed before.
 */
function splitTranscript(messages: BaseMessage[]): {
  system: string;
  history: Exchange[];
  user: string;
} {
  const system = messages
    .filter((m) => m.getType() === "system")
    .map(text)
    .join("\n\n");
  const turns = messages.filter((m) => m.getType() === "human" || m.getType() === "ai");
  const last = turns[turns.length - 1];
  const user = last?.getType() === "human" ? text(last) : "";
  const scope = user ? turns.slice(0, -1) : turns;
  const history: Exchange[] = [];
  for (let i = 0; i < scope.length - 1; i++) {
    if (scope[i].getType() !== "human" || scope[i + 1].getType() !== "ai") continue;
    history.push({ user: text(scope[i]), assistant: text(scope[i + 1]) });
    i++;
  }
  return { system, history, user };
}

export class CliChatModel extends BaseChatModel<BaseChatModelCallOptions> {
  private readonly provider: CliProviderId;
  private readonly model?: string;
  private readonly effort?: ChatEffort;

  /**
   * Where tool/status/usage frames go. The agent node re-points this at the
   * current run's custom-stream writer before each invoke; the model object
   * lives for one HTTP request, same as the graph it's bound into.
   */
  frames: ((frame: AgentFrame) => void) | null = null;

  constructor(fields: CliChatModelFields) {
    super(fields);
    this.provider = fields.provider;
    this.model = fields.model;
    this.effort = fields.effort;
  }

  _llmType(): string {
    return `cli-${this.provider}`;
  }

  /** The CLI turn, with its progress events pointed at the graph's writer. */
  private run(
    messages: BaseMessage[],
    signal: AbortSignal | undefined,
    onText?: (chunk: string) => void,
  ) {
    const { system, history, user } = splitTranscript(messages);
    if (!user) throw new Error("cli model: no user message in the transcript");
    const tools = cliSupportsTools(this.provider);
    const prompt = buildCliPrompt(system, history, user, { tools });
    return cliChat(this.provider, prompt, signal, {
      tools,
      model: this.model,
      effort: this.effort,
      events: {
        onText,
        onThinking: () => this.frames?.({ type: "status", label: "Thinking…" }),
        onTool: (run) =>
          this.frames?.({
            type: "tool",
            name: run.label,
            label: run.label,
            state: run.state,
            ...(run.detail && { detail: run.detail }),
          }),
      },
    });
  }

  async _generate(
    messages: BaseMessage[],
    options: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun,
  ): Promise<ChatResult> {
    const { text: answer, usage } = await this.run(
      messages,
      options.signal,
      (chunk) => void runManager?.handleLLMNewToken(chunk),
    );
    if (usage) this.frames?.({ type: "usage", usage });
    return { generations: [{ text: answer, message: new AIMessage(answer) }] };
  }

  /**
   * Chunks as the CLI produces them. The callback-to-generator bridge is a
   * queue and a wake-up: text arrives on onText, the loop below drains it, and
   * a CLI that never streams (Codex, Gemini, Copilot) yields its answer once
   * when the call settles.
   */
  async *_streamResponseChunks(
    messages: BaseMessage[],
    options: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun,
  ): AsyncGenerator<ChatGenerationChunk> {
    const queue: string[] = [];
    let settled = false;
    let failure: unknown;
    let result: Awaited<ReturnType<typeof cliChat>> | null = null;
    let wake: (() => void) | null = null;
    const notify = () => {
      wake?.();
      wake = null;
    };
    void this.run(messages, options.signal, (chunk) => {
      queue.push(chunk);
      notify();
    }).then(
      (r) => {
        result = r;
        settled = true;
        notify();
      },
      (err) => {
        failure = err;
        settled = true;
        notify();
      },
    );

    let streamed = false;
    const chunkOf = (text: string) =>
      new ChatGenerationChunk({ text, message: new AIMessageChunk({ content: text }) });
    for (;;) {
      while (queue.length) {
        const text = queue.shift()!;
        streamed = true;
        yield chunkOf(text);
        await runManager?.handleLLMNewToken(text);
      }
      if (settled) break;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
    if (failure) throw failure;
    const done = result as Awaited<ReturnType<typeof cliChat>> | null;
    if (!streamed && done?.text) {
      yield chunkOf(done.text);
      await runManager?.handleLLMNewToken(done.text);
    }
    if (done?.usage) this.frames?.({ type: "usage", usage: done.usage });
  }
}
