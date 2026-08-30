/**
 * Langfuse — optional LLM observability, wired the same way LangSmith is:
 * env-gated, off by default, and with it off nothing initializes and nothing
 * leaves the machine. Set LANGFUSE_PUBLIC_KEY + LANGFUSE_SECRET_KEY (and
 * LANGFUSE_BASE_URL for a self-hosted instance) to turn it on.
 *
 * Current SDK (v5, OTEL-based, the scoped @langfuse/* packages — the legacy
 * `langfuse` package is the superseded v3 line): a LangfuseSpanProcessor on a
 * NodeSDK exports spans, the LangChain CallbackHandler turns every Ask
 * Grapevine turn into a trace grouped by thread via sessionId, and the client
 * pushes conversation-eval verdicts as session scores so the judge's numbers
 * chart in Langfuse next to the traces they grade.
 *
 * Everything here is best-effort: observability that can fail a chat turn or
 * an eval is worse than none, so failures log once and are swallowed.
 */
import { LangfuseClient } from "@langfuse/client";
import { CallbackHandler } from "@langfuse/langchain";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { NodeSDK } from "@opentelemetry/sdk-node";
import type { ConversationEval } from "./types.js";

export function langfuseEnabled(): boolean {
  return !!(process.env.LANGFUSE_PUBLIC_KEY && process.env.LANGFUSE_SECRET_KEY);
}

let sdk: NodeSDK | null = null;
let client: LangfuseClient | null = null;
let warned = false;

function warnOnce(err: unknown): void {
  if (warned) return;
  warned = true;
  console.warn(`[langfuse] disabled after error: ${String(err).slice(0, 200)}`);
}

/** Register the span processor once, lazily, and only when keys are set. */
function start(): boolean {
  if (!langfuseEnabled()) return false;
  if (sdk) return true;
  try {
    sdk = new NodeSDK({ spanProcessors: [new LangfuseSpanProcessor()] });
    sdk.start();
    return true;
  } catch (err) {
    warnOnce(err);
    return false;
  }
}

/**
 * A per-turn LangChain callback handler, or null when Langfuse is off.
 * sessionId = the chat thread id, so Langfuse's session view groups a
 * conversation's turns exactly the way chat_threads does.
 */
export function langfuseHandler(opts: {
  threadId: string;
  userId?: string;
  model: string;
}): CallbackHandler | null {
  if (!start()) return null;
  try {
    return new CallbackHandler({
      sessionId: opts.threadId,
      userId: opts.userId,
      tags: ["ask-grapevine"],
      traceMetadata: { model: opts.model },
    });
  } catch (err) {
    warnOnce(err);
    return null;
  }
}

/**
 * Mirror one judged conversation into Langfuse as session scores — the
 * overall verdict plus each metric, attached to the same sessionId the
 * turn traces carry. Postgres stays the source of truth; this is the copy
 * that makes Langfuse's score dashboards and alerts usable.
 */
export async function recordConversationScores(ev: ConversationEval): Promise<void> {
  if (!start()) return;
  try {
    client ??= new LangfuseClient();
    await Promise.all([
      client.score.create({
        sessionId: ev.threadId,
        name: "conversation.overall",
        value: ev.overall,
        dataType: "NUMERIC",
        comment: `${ev.verdict} · judged by ${ev.model}`,
      }),
      ...ev.scores.map((s) =>
        client!.score.create({
          sessionId: ev.threadId,
          name: `conversation.${s.metric}`,
          value: s.score,
          dataType: "NUMERIC",
          comment: s.reason ?? undefined,
        }),
      ),
    ]);
    await client.flush();
  } catch (err) {
    warnOnce(err);
  }
}
