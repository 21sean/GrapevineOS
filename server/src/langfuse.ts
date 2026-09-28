/**
 * Langfuse: optional LLM observability, wired the same way LangSmith is:
 * env-gated, off by default, and with it off nothing initializes and nothing
 * leaves the machine. Set LANGFUSE_PUBLIC_KEY + LANGFUSE_SECRET_KEY (and
 * LANGFUSE_BASE_URL for a self-hosted instance) to turn it on.
 *
 * Current SDK (v5, OTEL-based, the scoped @langfuse/* packages; the legacy
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
import { defaultResource, resourceFromAttributes } from "@opentelemetry/resources";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { logger } from "./log.js";
import type { ConversationEval } from "./types.js";

const log = logger("langfuse");

export function langfuseEnabled(): boolean {
  return !!(process.env.LANGFUSE_PUBLIC_KEY && process.env.LANGFUSE_SECRET_KEY);
}

let sdk: NodeSDK | null = null;
let client: LangfuseClient | null = null;

/** One warning per failing site, not one for the whole module: the first
 * site to fail used to silence the other three. */
const warnedSites = new Set<string>();

function warnOnce(site: string, err: unknown): void {
  if (warnedSites.has(site)) return;
  warnedSites.add(site);
  log.warn(
    { site, err: String(err).slice(0, 200) },
    "langfuse: giving up on this site after an error",
  );
}

/**
 * Scores are batched: one flush a few seconds after the last score rather
 * than one per rail decision, which under a burst was a POST per scan.
 */
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    client?.flush().catch((err) => warnOnce("flush", err));
  }, 5_000);
  flushTimer.unref?.();
}

/** Flush what is queued and stop the exporter; the shutdown hook calls this. */
export async function shutdownLangfuse(): Promise<void> {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  try {
    await client?.flush();
    await sdk?.shutdown();
  } catch (err) {
    warnOnce("shutdown", err);
  }
}

/**
 * PII scrub applied to every exported observation (LANGFUSE_MASK=off skips
 * it). Chat text is the payload here, so this is deliberately narrow: strip
 * the identifiers people paste (emails, phone numbers) and leave the
 * conversation readable. A mask that redacts the transcript would defeat
 * the reason for exporting it.
 */
function scrubPII(text: string): string {
  return text
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+\w/g, "[email]")
    .replace(/(?:\+?\d{1,2}[\s.-])?(?:\(\d{3}\)|\d{3})[\s.-]\d{3}[\s.-]?\d{4}\b/g, "[phone]");
}

/** Register the span processor once, lazily, and only when keys are set. */
function start(): boolean {
  if (!langfuseEnabled()) return false;
  if (sdk) return true;
  try {
    sdk = new NodeSDK({
      spanProcessors: [
        new LangfuseSpanProcessor({
          ...(process.env.LANGFUSE_MASK !== "off" && {
            mask: ({ data }: { data: unknown }) =>
              typeof data === "string" ? scrubPII(data) : data,
          }),
        }),
      ],
      // Resource auto-detection is the other half of the PII story: left on, it
      // stamps the host name, OS user and script path of the machine running the
      // server onto every span's metadata, which no scrubPII mask ever sees.
      // Declare the resource by hand instead.
      autoDetectResources: false,
      resource: defaultResource().merge(
        resourceFromAttributes({
          "service.name": "grapevine-server",
          ...(process.env.GRAPEVINE_RELEASE && {
            "service.version": process.env.GRAPEVINE_RELEASE,
          }),
        }),
      ),
    });
    sdk.start();
    return true;
  } catch (err) {
    warnOnce("start", err);
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
  /** The HTTP request id, so a trace and a support question share a handle. */
  requestId?: string;
}): CallbackHandler | null {
  if (!start()) return null;
  try {
    return new CallbackHandler({
      sessionId: opts.threadId,
      userId: opts.userId,
      tags: ["ask-grapevine"],
      traceMetadata: { model: opts.model, ...(opts.requestId && { request_id: opts.requestId }) },
    });
  } catch (err) {
    warnOnce("handler", err);
    return null;
  }
}

/**
 * Mirror one guardrail decision as a session score, so a blocked turn's
 * trace sits next to the number that blocked it. Only scored rails ship
 * (input/content; the output rail is regex and has no measurement), and
 * only decisions that belong to a thread. Fire-and-forget like everything
 * else here; Postgres (guardrail_scans) stays the source of truth.
 */
export function recordRailScore(scan: {
  rail: string;
  surface?: string;
  score?: number;
  blocked: boolean;
  wouldBlock?: boolean;
  threadId?: string;
}): void {
  if (!start() || scan.score === undefined || !scan.threadId) return;
  try {
    client ??= new LangfuseClient();
    const outcome = scan.blocked ? "blocked" : scan.wouldBlock ? "would block" : "pass";
    void Promise.resolve(
      client.score.create({
        sessionId: scan.threadId,
        name: `rail.${scan.rail}`,
        value: scan.score,
        dataType: "NUMERIC",
        comment: `${scan.surface ?? "unknown"} · ${outcome}`,
      }),
    )
      .then(scheduleFlush)
      .catch((err) => warnOnce("rail score", err));
  } catch (err) {
    warnOnce("rail score", err);
  }
}

/**
 * Mirror one judged conversation into Langfuse as session scores: the
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
    scheduleFlush();
  } catch (err) {
    warnOnce("conversation scores", err);
  }
}
