/**
 * OTEL plumbing for the Langfuse traffic simulator.
 *
 * This module is mechanics only: it stands up an isolated tracer provider that
 * can write tens of thousands of backdated spans into the self-hosted Langfuse
 * without leaking anything about the machine it runs on, and it posts scores
 * with timestamps the SDK refuses to backdate. No Grapevine content lives here
 * (that is content.ts) and no simulation policy (that is simulate-traffic.ts).
 *
 * Four things here are load bearing and were each learned the hard way:
 *
 *  1. NodeTracerProvider, not NodeSDK. NodeSDK auto-detects resources, which
 *     bolts the operator's host name, OS user and script path onto every span's
 *     metadata. Observability data in this project carries synthetic tester
 *     identities only, so the resource is declared explicitly instead.
 *  2. OTEL_BSP_MAX_QUEUE_SIZE must be set BEFORE the span processor is built.
 *     LangfuseSpanProcessorParams has no maxQueueSize field, the underlying
 *     BatchSpanProcessor defaults to 2048, and everything past that is dropped
 *     with a diag.warn nobody sees. Same story for the export timeout, whose
 *     5 second default loses whole batches of fat chat payloads.
 *  3. Flush in chunks. forceFlush() fires ceil(queued / batch) exports at once
 *     through Promise.all, so draining 6000 queued spans in one call opens two
 *     dozen simultaneous POSTs at a local container.
 *  4. Scores cannot be backdated through the SDK: LangfuseClient.score.create()
 *     hardcodes timestamp: new Date().toISOString() on the envelope, and that
 *     envelope timestamp is exactly what lands in the scores table. Posting the
 *     ingestion envelope by hand is the only way to put a score next to the
 *     July trace it grades, and it is also the only path that accepts
 *     source: "EVAL".
 *
 * Re-runnable: yes for scores (deterministic ids merge in the ReplacingMergeTree).
 * No for spans, which get random OTEL ids every run and therefore duplicate.
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { LangfuseClient } from "@langfuse/client";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { setLangfuseTracerProvider, startObservation } from "@langfuse/tracing";
import { defaultResource, resourceFromAttributes } from "@opentelemetry/resources";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";

/** Live tracing switched on here; simulated traffic must stay strictly older. */
export const LIVE_TRACING_SINCE = Date.parse("2026-09-01T15:30:00Z");

export const RELEASE = "grapevine@2026.09.01";
export const SERVICE_NAME = "grapevine-server";
export const SERVICE_VERSION = "2026.09.01";

// Both must be set before `new LangfuseSpanProcessor(...)`: the BatchSpanProcessor
// shim reads them in its constructor and there is no programmatic equivalent.
process.env.OTEL_BSP_MAX_QUEUE_SIZE ??= "32768";
process.env.OTEL_BSP_EXPORT_TIMEOUT ??= "60000";

let processor: LangfuseSpanProcessor | null = null;
let provider: NodeTracerProvider | null = null;

/** Stand up the isolated provider. Safe to call twice; only the first builds. */
export function startTracing(): void {
  if (processor) return;
  if (!process.env.LANGFUSE_PUBLIC_KEY || !process.env.LANGFUSE_SECRET_KEY) {
    throw new Error("LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY missing from server/.env");
  }
  processor = new LangfuseSpanProcessor({
    publicKey: process.env.LANGFUSE_PUBLIC_KEY,
    secretKey: process.env.LANGFUSE_SECRET_KEY,
    baseUrl: process.env.LANGFUSE_BASE_URL ?? "http://localhost:3000",
    flushAt: 256,
    flushInterval: 1,
    timeout: 60,
    // Skips the per-span base64 data-URI scan. Synthetic text has no media in it
    // and the scan is the single biggest CPU cost of a large seed.
    mediaUploadEnabled: false,
    release: RELEASE,
  });
  provider = new NodeTracerProvider({
    spanProcessors: [processor],
    resource: defaultResource().merge(
      resourceFromAttributes({
        "service.name": SERVICE_NAME,
        "service.version": SERVICE_VERSION,
      }),
    ),
  });
  setLangfuseTracerProvider(provider);
}

/**
 * Prove the provider is actually recording before writing thousands of spans.
 * With no provider registered the API hands back non-recording no-op spans and
 * the entire run vanishes without a single error.
 */
export function assertRecording(): void {
  const probe = startObservation("bootstrap-probe", {}, { asType: "span" });
  const ctx = probe.otelSpan.spanContext();
  // Deliberately never ended: export happens in the processor's onEnd, so an
  // abandoned probe proves the provider is live without leaving a junk trace.
  const ok = probe.otelSpan.isRecording() && /^[0-9a-f]{32}$/.test(ctx.traceId) && ctx.traceId !== "0".repeat(32);
  if (!ok) {
    throw new Error("no tracer provider registered: spans would be silently discarded");
  }
}

let sinceFlush = 0;

/** Drain roughly every 500 spans rather than in one giant fan-out at the end. */
export async function maybeFlush(spansAdded: number): Promise<void> {
  sinceFlush += spansAdded;
  if (sinceFlush >= 500) {
    sinceFlush = 0;
    await processor?.forceFlush();
  }
}

export async function finishTracing(): Promise<void> {
  await processor?.forceFlush();
  await provider?.shutdown();
}

/** Clamp so an end never precedes its start (OTEL pins such a span to 0ms). */
export function clampEnd(start: Date, endMs: number): Date {
  return new Date(Math.max(endMs, start.getTime() + 1));
}

// ---------------------------------------------------------------------------
// Scores: hand-built ingestion envelopes, because the SDK cannot backdate
// ---------------------------------------------------------------------------

export interface ScoreBody {
  id: string;
  name: string;
  value: number | string;
  dataType: "NUMERIC" | "CATEGORICAL" | "BOOLEAN";
  traceId?: string;
  observationId?: string;
  sessionId?: string;
  comment?: string;
  configId?: string;
  environment?: string;
  /** Ingestion accepts EVAL; the public score endpoint does not. */
  source?: "API" | "EVAL" | "ANNOTATION";
  metadata?: Record<string, unknown>;
}

export interface DatedScore {
  at: Date;
  body: ScoreBody;
}

let client: LangfuseClient | null = null;

/**
 * Post scores with their own timestamps. body.id is the ClickHouse dedup key,
 * so deterministic ids make a re-run merge instead of doubling every chart.
 * The envelope timestamp is both the backdate and the merge tiebreak, so it has
 * to stay stable across runs too.
 */
export async function ingestScores(scores: DatedScore[]): Promise<number> {
  client ??= new LangfuseClient();
  let sent = 0;
  for (let i = 0; i < scores.length; i += 100) {
    const batch = scores.slice(i, i + 100).map((s) => ({
      id: `evt-${s.body.id}`,
      type: "score-create" as const,
      timestamp: s.at.toISOString(),
      body: s.body,
    }));
    const res = (await client.api.ingestion.batch({ batch } as never)) as {
      errors?: unknown[];
    };
    if (res.errors?.length) {
      console.error(`  ingestion errors: ${JSON.stringify(res.errors).slice(0, 600)}`);
    }
    sent += batch.length;
  }
  return sent;
}

// ---------------------------------------------------------------------------
// Reset: take the previous simulated run back out before writing a new one
// ---------------------------------------------------------------------------

/**
 * Spans are one-shot by construction: OTEL ids are random per run and
 * events_core is a ReplacingMergeTree keyed on (project, minute, trace hash,
 * span id, start time), so a second run stacks a second helping of traffic on
 * top of the first rather than replacing it. Re-emitting therefore has to be
 * preceded by a delete, and the delete has to be reproducible from the repo
 * rather than typed into a shell once and forgotten, which is what this is.
 *
 * It removes exactly what the simulator wrote and nothing else:
 *   - every span sharing a trace id with a root whose session id starts with
 *     the run's prefix (the children carry no session id of their own on a run
 *     written before the identity fix, which is why the trace ids are resolved
 *     first and the delete keys on them),
 *   - from BOTH events_core and events_full, which the UI reads separately and
 *     which would otherwise disagree,
 *   - and the scores that run posted, which carry the same prefix in their
 *     deterministic ids.
 *
 * It refuses to run if the trace set it resolved touches an experiment, a demo
 * session or a verify-* trace, which are other seeders' rows.
 */

const CH_URL = process.env.CLICKHOUSE_URL ?? "http://127.0.0.1:8123";
const CH_USER = process.env.CLICKHOUSE_USER ?? "clickhouse";

/** The stack's compose env is the only place the ClickHouse password lives. */
function clickhousePassword(): string {
  if (process.env.CLICKHOUSE_PASSWORD) return process.env.CLICKHOUSE_PASSWORD;
  const envPath = fileURLToPath(new URL("../../../observability/langfuse/.env", import.meta.url));
  const line = readFileSync(envPath, "utf8")
    .split(/\r?\n/)
    .find((l) => l.startsWith("CLICKHOUSE_PASSWORD="));
  if (!line) throw new Error(`CLICKHOUSE_PASSWORD not found in ${envPath}`);
  return line.slice("CLICKHOUSE_PASSWORD=".length).trim();
}

async function ch(sql: string): Promise<string> {
  const auth = Buffer.from(`${CH_USER}:${clickhousePassword()}`).toString("base64");
  const res = await fetch(CH_URL, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}` },
    body: sql,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`clickhouse ${res.status}: ${text.slice(0, 800)}`);
  return text;
}

export async function resetSimulatedRun(prefix: string): Promise<void> {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(prefix)) {
    throw new Error(`refusing to reset on an unsafe prefix: ${prefix}`);
  }
  const ids = (
    await ch(`SELECT DISTINCT trace_id FROM events_core WHERE session_id LIKE '${prefix}-%' FORMAT TSV`)
  )
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^[0-9a-f]{32}$/.test(l));

  const scoreRows = Number(
    (await ch(`SELECT count() FROM scores WHERE id LIKE '${prefix}-%' FORMAT TSV`)).trim(),
  );

  if (!ids.length) {
    console.log(`reset: no '${prefix}-' traces in ClickHouse; ${scoreRows} score rows to clear`);
  } else {
    const list = ids.map((id) => `'${id}'`).join(",");
    // Count first, and refuse if the trace set has picked up anything that
    // belongs to another seeder. Better a failed reset than a deleted dataset run.
    const [rowsCore, experiments, foreign, traces] = (
      await ch(
        `SELECT count(), countIf(experiment_id != ''),` +
          ` countIf(session_id LIKE 'demo-%' OR session_id LIKE 'verify-%'), uniq(trace_id)` +
          ` FROM events_core WHERE trace_id IN (${list}) FORMAT TSV`,
      )
    )
      .trim()
      .split("\t")
      .map(Number);
    const rowsFull = Number(
      (await ch(`SELECT count() FROM events_full WHERE trace_id IN (${list}) FORMAT TSV`)).trim(),
    );
    if (experiments > 0 || foreign > 0) {
      throw new Error(
        `reset aborted: the '${prefix}-' trace set touches ${experiments} experiment rows and ${foreign} demo/verify rows`,
      );
    }
    console.log(
      `reset: deleting ${rowsCore} events_core rows / ${rowsFull} events_full rows across ${traces} traces, plus ${scoreRows} scores`,
    );
    // mutations_sync = 2 so the delete is done before the re-emit starts,
    // otherwise the tabs briefly hold both runs at once.
    await ch(`ALTER TABLE events_full DELETE WHERE trace_id IN (${list}) SETTINGS mutations_sync = 2`);
    await ch(`ALTER TABLE events_core DELETE WHERE trace_id IN (${list}) SETTINGS mutations_sync = 2`);
  }
  if (scoreRows > 0) {
    await ch(`ALTER TABLE scores DELETE WHERE id LIKE '${prefix}-%' SETTINGS mutations_sync = 2`);
  }
  const left = Number(
    (await ch(`SELECT count() FROM events_core WHERE session_id LIKE '${prefix}-%' FORMAT TSV`)).trim(),
  );
  const scoresLeft = Number(
    (await ch(`SELECT count() FROM scores WHERE id LIKE '${prefix}-%' FORMAT TSV`)).trim(),
  );
  console.log(`reset: done. ${left} '${prefix}-' spans and ${scoresLeft} '${prefix}-' scores remain`);
}
