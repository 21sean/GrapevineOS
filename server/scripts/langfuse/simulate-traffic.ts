/**
 * The Ask Grapevine traffic simulator.
 *
 * Langfuse only looks like a product's observability once it holds a product's
 * worth of history. This writes about eight weeks of concierge traffic into the
 * self-hosted instance: roughly 30 visitors, a few hundred sessions, over a
 * thousand turns, each one a full span tree that matches what the live LangGraph
 * actually emits (root agent, input rail, recall fold, event digest, one or two
 * generations, the tools it called, sometimes an output rail and a judge).
 *
 * What makes it look real rather than generated:
 *  - Shape in time. Evenings peak, lunchtime bumps, 2am is dead, Thursday to
 *    Saturday carry the week, the last 30 days are dense because that is what
 *    the default date picker shows, and there is one genuinely quiet stretch
 *    plus a couple of bursts.
 *  - Shape in people. Two heavy users, a long tail of one-session visitors.
 *  - Shape in failure. About 4 percent of turns error and 8 percent warn, each
 *    with a status message that names a failure this system actually has
 *    (ollama loading a model, a CLI provider timing out, SearXNG falling over
 *    to DuckDuckGo, a verification pass finding nothing).
 *  - Shape in words. Every question and answer comes from content.ts, composed
 *    out of the real Supabase catalog. No invented events.
 *
 * Scores are posted separately as hand-built ingestion envelopes, because the
 * SDK stamps every score with the wall clock and a July trace with a September
 * score grades nothing.
 *
 * Every span in a turn carries the turn's whole identity, not just its root:
 * session id, user id, trace name, tags, environment, release and version. The
 * ingestion path reads those per span with no inheritance from the parent, and
 * since the cost and the tokens live on the generations, which are children,
 * leaving them off is what empties the Users tab, the Sessions tab and every
 * cost widget in the product. See the comment on stamp().
 *
 * Spans are one-shot: OTEL ids are random per run, so a second run adds a
 * second helping of traffic rather than replacing the first. --reset takes the
 * previous run out first, which makes the whole thing re-runnable. Scores use
 * deterministic ids derived from the session id, so those merge on a re-run
 * with the same seed and window.
 *
 *   npx tsx scripts/langfuse/simulate-traffic.ts --dry-run
 *   npx tsx scripts/langfuse/simulate-traffic.ts --audit
 *   npx tsx scripts/langfuse/simulate-traffic.ts --audit --no-inherit
 *   npx tsx scripts/langfuse/simulate-traffic.ts --reset-only
 *   npx tsx scripts/langfuse/simulate-traffic.ts --turns 40 --from 2026-08-25 --prefix probe
 *   npx tsx scripts/langfuse/simulate-traffic.ts --reset
 */
import { verdictOf } from "../../src/evals/judge-rubric.js";
import "dotenv/config";
import { startObservation } from "@langfuse/tracing";
import type { SpanContext } from "@opentelemetry/api";
import { TESTERS } from "../testers.js";
import {
  assertRecording,
  clampEnd,
  finishTracing,
  ingestScores,
  LIVE_TRACING_SINCE,
  maybeFlush,
  resetSimulatedRun,
  startTracing,
  type DatedScore,
} from "./otel-bootstrap.js";
import {
  buildConversation,
  choice,
  constraintViolations,
  ERRORS,
  setConstraintInheritance,
  loadCatalog,
  makeRng,
  ptWeekday,
  TOOL_CATALOG,
  WARNINGS,
  weighted,
  type CatalogEvent,
  type Rng,
  type Turn,
} from "./content.js";

// ---------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (name: string): boolean => process.argv.includes(`--${name}`);

const DRY_RUN = has("dry-run");
/**
 * Take the previous run's spans and scores out before writing new ones.
 * Without it a second run stacks on top of the first, because OTEL span ids are
 * random per run and nothing in ClickHouse dedupes them.
 */
const RESET = has("reset") || has("reset-only");
/** Clear the previous run and stop, without writing a replacement. */
const RESET_ONLY = has("reset-only");
/** Build conversations and check them for broken constraints; ingest nothing. */
const AUDIT = has("audit");
const SEED = Number(flag("seed") ?? 20260901);
const FROM = Date.parse(`${flag("from") ?? "2026-07-05"}T00:00:00Z`);
// Strictly before live tracing switched on, so simulated turns cannot be
// mistaken for the three real traces the running app produced.
const TO = Math.min(
  Date.parse(`${flag("to") ?? "2026-09-01"}T23:59:59Z`),
  LIVE_TRACING_SINCE - 60_000,
);
const TURN_TARGET = Number(flag("turns") ?? 1200);
const SKIP_SCORES = has("no-scores");
// Session-id prefix. Smoke runs use their own so their rows can be deleted
// afterwards without touching the real seed.
const PREFIX = flag("prefix") ?? "sim";

const DAY_MS = 86_400_000;
/** San Diego is UTC-7 all window, so a PT midnight is 07:00Z. */
const PT_OFFSET_HOURS = 7;

// ---------------------------------------------------------------------------
// Volume shape
// ---------------------------------------------------------------------------

/** Evening peak, lunchtime bump, nobody awake between 2 and 6. */
const HOUR_WEIGHT = [
  0.3, 0.14, 0.04, 0.02, 0.02, 0.03, 0.1, 0.28, 0.42, 0.5, 0.55, 0.7, 0.95, 0.88, 0.58, 0.52, 0.62,
  0.95, 1.2, 1.6, 1.55, 1.2, 0.78, 0.48,
];

/** Thursday through Saturday carry the week. */
const DOW_WEIGHT = [0.85, 0.58, 0.6, 0.78, 1.1, 1.4, 1.35];

/** A burst is a launch, a festival week, or a link that did the rounds. */
const BURSTS: [string, string, number][] = [
  ["2026-08-06", "2026-08-09", 1.9],
  ["2026-08-20", "2026-08-24", 2.2],
  ["2026-08-29", "2026-09-01", 1.7],
];

/** The stretch where nothing much happened, because real products have those. */
const QUIET: [string, string, number] = ["2026-07-26", "2026-08-03", 0.28];

function inRange(dayKey: string, from: string, to: string): boolean {
  return dayKey >= from && dayKey <= to;
}

function dayWeight(dayStartMs: number): number {
  const key = new Date(dayStartMs).toISOString().slice(0, 10);
  // The last 30 days are what the default picker shows, so that is where the
  // density has to be; July is a real but thinner tail.
  const ageDays = (TO - dayStartMs) / DAY_MS;
  const recency = ageDays <= 30 ? 1 : ageDays <= 45 ? 0.55 : 0.34;
  let w = recency * DOW_WEIGHT[ptWeekday(dayStartMs)];
  for (const [a, b, m] of BURSTS) if (inRange(key, a, b)) w *= m;
  if (inRange(key, QUIET[0], QUIET[1])) w *= QUIET[2];
  return w;
}

function pickHour(rng: Rng): number {
  const total = HOUR_WEIGHT.reduce((a, b) => a + b, 0);
  let r = rng() * total;
  for (let h = 0; h < 24; h++) {
    r -= HOUR_WEIGHT[h];
    if (r <= 0) return h;
  }
  return 20;
}

/** Many one-turn sessions, a fat tail, a few genuinely long conversations. */
const SESSION_LENGTH: [number, number][] = [
  [1, 34],
  [2, 20],
  [3, 15],
  [4, 10],
  [5, 7],
  [6, 6],
  [8, 4],
  [10, 2.5],
  [12, 1.5],
];

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

interface ModelSpec {
  /** provided_model_name, which is what resolves a price row. */
  model: string;
  /** Span name, matching what the LangChain callback handler really produces. */
  genName: string;
  /** trace metadata.model, the provider the user picked in the UI. */
  provider: string;
  surface: "chat" | "chat-cli";
  ttft: [number, number];
  total: [number, number];
}

const MODELS: [ModelSpec, number][] = [
  [
    {
      model: "qwen3.6:35b-a3b-q4_K_M",
      genName: "qwen3.6:35b-a3b-q4_K_M",
      provider: "ollama",
      surface: "chat",
      ttft: [520, 2400],
      total: [3800, 15000],
    },
    30,
  ],
  [
    {
      model: "qwen3.6:27b",
      genName: "qwen3.6:27b",
      provider: "ollama",
      surface: "chat",
      ttft: [600, 2600],
      total: [4200, 17000],
    },
    11,
  ],
  [
    {
      model: "gpt-oss:120b",
      genName: "gpt-oss:120b",
      provider: "ollama",
      surface: "chat",
      ttft: [900, 3200],
      total: [6000, 22000],
    },
    7,
  ],
  [
    {
      model: "laguna-xs-2.1:latest",
      genName: "laguna-xs-2.1:latest",
      provider: "ollama",
      surface: "chat",
      ttft: [180, 700],
      total: [900, 4200],
    },
    5,
  ],
  [
    {
      model: "claude-sonnet-5",
      genName: "CliChatModel",
      provider: "claude",
      surface: "chat-cli",
      ttft: [1100, 3400],
      total: [5000, 21000],
    },
    15,
  ],
  [
    {
      model: "claude-opus-5",
      genName: "CliChatModel",
      provider: "claude",
      surface: "chat-cli",
      ttft: [1500, 4200],
      total: [8000, 30000],
    },
    11,
  ],
  [
    {
      model: "gpt-5.2",
      genName: "CliChatModel",
      provider: "codex",
      surface: "chat-cli",
      ttft: [1200, 3800],
      total: [6000, 24000],
    },
    9,
  ],
  [
    {
      model: "gpt-5.4-mini",
      genName: "CliChatModel",
      provider: "codex",
      surface: "chat-cli",
      ttft: [700, 2000],
      total: [3000, 11000],
    },
    6,
  ],
  [
    {
      model: "gemini-3-pro-preview",
      genName: "CliChatModel",
      provider: "gemini",
      surface: "chat-cli",
      ttft: [1000, 3000],
      total: [5000, 19000],
    },
    6,
  ],
];

/**
 * The turn-latency objective. Generous on purpose: a CLI provider shells out to
 * a subprocess and a turn with two model rounds plus tool calls is genuinely
 * slow, so a tighter number would just paint every hosted turn red.
 */
const LATENCY_SLO_MS = 25_000;

const JUDGE_MODEL = "qwen3.6:27b";
const EMBED_MODEL = "nomic-embed-text";

/** Releases and graph versions, so the Release and Version filters mean something. */
function releaseFor(ms: number): string {
  const key = new Date(ms).toISOString().slice(0, 10);
  if (key < "2026-08-01") return "grapevine@2026.07.02";
  if (key < "2026-08-20") return "grapevine@2026.08.05";
  return "grapevine@2026.09.01";
}

function graphVersionFor(ms: number): string {
  const key = new Date(ms).toISOString().slice(0, 10);
  return key < "2026-08-01"
    ? "agent-graph@5"
    : key < "2026-08-20"
      ? "agent-graph@6"
      : "agent-graph@7";
}

/** The concierge prompt really was rewritten twice across this window. */
function conciergeVersion(ms: number): number {
  const key = new Date(ms).toISOString().slice(0, 10);
  return key < "2026-07-20" ? 1 : key < "2026-08-16" ? 2 : 3;
}

function judgeVersion(ms: number): number {
  const key = new Date(ms).toISOString().slice(0, 10);
  return key < "2026-08-01" ? 1 : key < "2026-08-20" ? 2 : 3;
}

// ---------------------------------------------------------------------------
// Score configs (ids read from the live project by the foundation step)
// ---------------------------------------------------------------------------

const CONFIG = {
  railInput: "e75d2dd2-3392-4df5-9f8e-965682915aac",
  railContent: "c8ce97b4-917c-4d23-8b39-472e2c645577",
  railOutput: "3a1d5c84-da9d-4cbd-b00f-45e55b7143a2",
  overall: "f8ffb4de-876a-4ee4-84bb-dad458a8d9e6",
  helpfulness: "a1705acd-4f8a-46f0-b861-3a745ce4e885",
  groundedness: "81ddae41-15e6-4f4f-8a16-0e398451a788",
  persona: "9ed3477d-e616-4f40-829d-7687616a0fde",
  userFeedback: "4a3fb02a-4e9e-40f1-afdf-534698862b22",
  answered: "44fc07ca-5982-44b6-942f-b63dcfa39e3e",
  latencySlo: "37fc7a4d-cced-45f0-aac5-dfe7b016ce9f",
  replyQuality: "a46cf9f8-dfae-446c-8ab9-dc971c3b039c",
} as const;

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

interface SessionPlan {
  id: string;
  userEmail: string;
  userName: string;
  startMs: number;
  turnCount: number;
  environment: string;
  spec: ModelSpec;
  effort: string;
}

function buildPlan(rng: Rng): SessionPlan[] {
  // Anchored at PT midnight, not UTC midnight: the diurnal and weekly shapes
  // describe San Diego evenings, and applying them to a UTC day would put the
  // peak at lunchtime and smear Saturday across two weekdays.
  const days: number[] = [];
  for (let t = FROM + PT_OFFSET_HOURS * 3600_000; t <= TO; t += DAY_MS) days.push(t);
  const weights = days.map(dayWeight);
  const totalWeight = weights.reduce((a, b) => a + b, 0);

  // Sessions needed to land on the turn target, given the length mix.
  const meanTurns =
    SESSION_LENGTH.reduce((s, [n, w]) => s + n * w, 0) /
    SESSION_LENGTH.reduce((s, [, w]) => s + w, 0);
  const sessionTarget = Math.max(1, Math.round(TURN_TARGET / meanTurns));

  // Cohorts rather than a flat draw, because that is how a real product's Users
  // tab looks: two people who live in the thing, a handful of regulars, and a
  // long tail of visitors who tried it once and left.
  const cohort = (i: number): number => (i < 2 ? 55 : i < 6 ? 18 : i < 14 ? 6 : 1.2);
  const people = TESTERS.map((t, i) => [t, cohort(i)] as [typeof t, number]);

  const plans: SessionPlan[] = [];
  let seq = 0;
  days.forEach((dayStart, di) => {
    const share = (weights[di] / totalWeight) * sessionTarget;
    let count = Math.floor(share);
    if (rng() < share - count) count++;
    for (let i = 0; i < count; i++) {
      // dayStart is PT midnight, so the drawn hour is a San Diego wall-clock hour.
      const startMs = dayStart + pickHour(rng) * 3600_000 + Math.floor(rng() * 3600_000);
      if (startMs > TO) continue;
      const person = weighted(rng, people);
      const spec = weighted(rng, MODELS);
      plans.push({
        id: `${PREFIX}-${new Date(dayStart).toISOString().slice(0, 10).replace(/-/g, "")}-${String(++seq).padStart(4, "0")}`,
        userEmail: person.email,
        userName: person.name,
        startMs,
        turnCount: weighted(rng, SESSION_LENGTH),
        environment: weighted(rng, [
          ["default", 88],
          ["staging", 8],
          ["development", 4],
        ] as [string, number][]),
        spec,
        effort: weighted(rng, [
          ["balanced", 70],
          ["quick", 20],
          ["deep", 10],
        ] as [string, number][]),
      });
    }
  });

  // Nobody should be invisible: give every persona at least one session.
  const seen = new Set(plans.map((p) => p.userEmail));
  let cursor = 0;
  for (const t of TESTERS) {
    if (seen.has(t.email)) continue;
    while (cursor < plans.length && plans[cursor].userEmail === plans[0].userEmail) cursor++;
    if (cursor >= plans.length) break;
    plans[cursor].userEmail = t.email;
    plans[cursor].userName = t.name;
    cursor++;
  }
  return plans.sort((a, b) => a.startMs - b.startMs);
}

// ---------------------------------------------------------------------------
// Emitting one turn
// ---------------------------------------------------------------------------

interface TurnOutcome {
  traceId: string;
  rootSpanId: string;
  genSpanId: string | null;
  spans: number;
  endMs: number;
  latencyMs: number;
  railInput: number;
  railContent: number | null;
  turn: Turn;
}

/**
 * Trace identity: the attributes that have to appear on EVERY span in a turn,
 * not only on its root.
 *
 * This is the fix for the defect with the widest blast radius in the whole
 * seed. Langfuse's OTEL ingestion reads user.id, session.id, the trace name,
 * the tags and the release off each span's own attributes (worker
 * OtelIngestionProcessor.js L357-365 calls extractUserId/extractSessionId/
 * extractTags per span, with no inheritance from the parent). A previous run
 * set them on the root only, so all 7,785 child spans landed with user_id = ''
 * and session_id = ''. Since every generation's cost and token usage lives on
 * a child, the Users tab read $0.00 for all 31 visitors, Sessions showed blank
 * cost and usage on every row, and the "user consumption" and "costliest
 * conversation" widgets collapsed into one unlabelled bucket.
 *
 * The release belongs here too: the span processor carries a default, but a
 * July turn ran on July's build, and leaving the default in place would tell
 * the Observations view that every child span shipped in September.
 *
 * propagateAttributes() from @langfuse/tracing is the other way to do this,
 * but it works through the ACTIVE OTEL context, and every span here is created
 * with the top-level startObservation(..., { startTime, parentSpanContext })
 * form so it can be backdated. That form takes its parent from the argument,
 * not from the active context, so propagation would not reach it. Setting the
 * raw attributes is the mechanism that actually works for backdated spans, and
 * it also sidesteps propagateAttributes' silent 200-character truncation.
 */
type TraceIdentity = Record<string, string | string[]>;

function stamp<T extends { otelSpan: { setAttributes(attrs: TraceIdentity): unknown } }>(
  obs: T,
  ident: TraceIdentity,
): T {
  obs.otelSpan.setAttributes(ident);
  return obs;
}

const between = (rng: Rng, lo: number, hi: number): number => lo + Math.floor(rng() * (hi - lo));

/** Prompt Guard is bimodal in practice: benign hugs zero, attacks hug one. */
function railScore(rng: Rng, adversarial: boolean): number {
  return adversarial
    ? Math.min(0.999, 0.68 + rng() * 0.32)
    : Math.max(0.0004, Math.pow(rng(), 3) * 0.11);
}

function emitTurn(
  rng: Rng,
  plan: SessionPlan,
  turn: Turn,
  turnIndex: number,
  startMs: number,
): TurnOutcome {
  const spec = plan.spec;
  const release = releaseFor(startMs);
  const version = graphVersionFor(startMs);
  const railIn = railScore(rng, turn.adversarial);

  // Failure injection. Blocked turns never reach a model, so they cannot fail.
  const failure = !turn.blocked && rng() < 0.04 ? choice(rng, ERRORS) : null;
  const warning = !failure && !turn.blocked && rng() < 0.08 ? choice(rng, WARNINGS) : null;
  const replyText = failure ? failure.reply : turn.replyText;

  const start = new Date(startMs);
  // Built once, then stamped on the root and on every single descendant.
  const ident: TraceIdentity = {
    "langfuse.trace.name": "ask-grapevine",
    "user.id": plan.userEmail,
    "session.id": plan.id,
    "langfuse.trace.tags": [...turn.tags, spec.provider],
    "langfuse.release": release,
  };
  const root = startObservation(
    "ask-grapevine",
    {
      input: turn.userText,
      output: replyText,
      level: failure ? "ERROR" : warning ? "WARNING" : "DEFAULT",
      ...(failure ? { statusMessage: failure.rootMessage } : {}),
      ...(warning ? { statusMessage: warning.statusMessage } : {}),
      version,
      environment: plan.environment,
      metadata: {
        ls_integration: "langgraph",
        thread_id: plan.id,
        model: spec.provider,
        tools: true,
        turn: turnIndex + 1,
        intent: turn.intent,
        effort: plan.effort,
      },
    },
    { startTime: start, asType: "agent" },
  );
  root.otelSpan.setAttributes({
    ...ident,
    "langfuse.trace.input": turn.userText,
    "langfuse.trace.output": replyText,
    "langfuse.trace.metadata.city": "san-diego",
    "langfuse.trace.metadata.surface": spec.surface,
    "langfuse.trace.metadata.intent": turn.intent,
    "langfuse.trace.metadata.thread_id": plan.id,
    "langfuse.trace.metadata.model": spec.provider,
    "langfuse.trace.metadata.turn": String(turnIndex + 1),
    ...(rng() < 0.02 ? { "langfuse.trace.public": true } : {}),
  });
  const parent: SpanContext = root.otelSpan.spanContext();
  let spans = 1;
  let t = startMs;

  const nodeMeta = (step: number, node: string) => ({
    ls_integration: "langgraph",
    thread_id: plan.id,
    model: spec.provider,
    langgraph_step: step,
    langgraph_node: node,
    langgraph_triggers: [`branch:to:${node}`],
    langgraph_path: ["__pregel_pull", node],
  });

  // --- input rail -----------------------------------------------------------
  const railMs = between(rng, 22, 90);
  const rail = stamp(
    startObservation(
      "input_rail",
      {
        input: { text: turn.userText, surface: spec.surface },
        output: {
          rail: "input",
          score: Number(railIn.toFixed(4)),
          decision: turn.blocked ? "blocked" : railIn > 0.45 ? "would block" : "pass",
        },
        level: turn.blocked ? "WARNING" : "DEFAULT",
        ...(turn.blocked ? { statusMessage: `input rail blocked at ${railIn.toFixed(3)}` } : {}),
        version,
        environment: plan.environment,
        metadata: nodeMeta(1, "input_rail"),
      },
      { startTime: new Date(t), parentSpanContext: parent, asType: "guardrail" },
    ),
    ident,
  );
  rail.end(new Date(t + railMs));
  spans++;
  t += railMs;

  let genSpanId: string | null = null;

  if (!turn.blocked) {
    // --- recall fold, on threads long enough to have scrolled history -------
    if (turnIndex >= 3 && rng() < 0.55) {
      const recallMs = between(rng, 900, 4200);
      const recall = stamp(
        startObservation(
          "recall",
          {
            input: { messages: turnIndex + 1, window: 24, stride: 8 },
            output: {
              summary: `${plan.userName.split(" ")[0]} is working through ${turn.intent.replace(/-/g, " ")} options, leaning to what is nearby and not expensive.`,
              summarized: turnIndex - 1,
            },
            level: failure?.node === "recall" ? "ERROR" : "DEFAULT",
            ...(failure?.node === "recall" ? { statusMessage: failure.statusMessage } : {}),
            version,
            environment: plan.environment,
            metadata: nodeMeta(2, "recall"),
          },
          { startTime: new Date(t), parentSpanContext: parent, asType: "chain" },
        ),
        ident,
      );
      const recallCtx = recall.otelSpan.spanContext();
      const inTok = between(rng, 600, 2400);
      const outTok = between(rng, 40, 180);
      const rgen = stamp(
        startObservation(
          spec.genName,
          {
            model: spec.model,
            modelParameters: { temperature: 0.2, num_ctx: 8192 },
            input: [
              {
                role: "system",
                content: "Fold the turns that scrolled out of the window into a running summary.",
              },
            ],
            output: { role: "assistant", content: "Summary updated." },
            usageDetails: { input: inTok, output: outTok, total: inTok + outTok },
            completionStartTime: new Date(t + between(rng, 200, 900)),
            prompt: {
              name: "thread-recall-summarizer",
              version: startMs < Date.parse("2026-08-10") ? 1 : 2,
              isFallback: false,
            },
            version,
            environment: plan.environment,
            metadata: {
              ls_integration: "langchain_chat_model",
              ls_model_type: "chat",
              node: "recall",
            },
          },
          { startTime: new Date(t + 30), parentSpanContext: recallCtx, asType: "generation" },
        ),
        ident,
      );
      rgen.end(clampEnd(new Date(t + 30), t + recallMs - 20));
      recall.end(new Date(t + recallMs));
      spans += 2;
      t += recallMs;
    }

    // --- event digest -------------------------------------------------------
    const digestMs = between(rng, 40, 190);
    const digest = stamp(
      startObservation(
        "digest",
        {
          input: { window_days: 14, filters: { city: "san-diego" }, intent: turn.intent },
          output: {
            candidates: turn.picks.length,
            ids: turn.picks.map((p) => p.id),
            catalog_scanned: between(rng, 180, 1003),
          },
          version,
          environment: plan.environment,
          metadata: { node: "digest", ls_integration: "langgraph" },
        },
        { startTime: new Date(t), parentSpanContext: parent, asType: "retriever" },
      ),
      ident,
    );
    const digestCtx = digest.otelSpan.spanContext();
    if (rng() < 0.18) {
      const embedMs = between(rng, 14, 70);
      const embTok = between(rng, 12, 60);
      const emb = stamp(
        startObservation(
          "embed_query",
          {
            model: EMBED_MODEL,
            input: turn.userText,
            output: { dimensions: 768 },
            usageDetails: { input: embTok, output: 0, total: embTok },
            version,
            environment: plan.environment,
            metadata: { node: "digest" },
          },
          { startTime: new Date(t + 5), parentSpanContext: digestCtx, asType: "embedding" },
        ),
        ident,
      );
      emb.end(new Date(t + 5 + embedMs));
      spans++;
    }
    digest.end(new Date(t + digestMs));
    spans++;
    t += digestMs;

    const promptLink = {
      name: "grapevine-concierge",
      version: conciergeVersion(startMs),
      isFallback: false,
    };

    const makeGeneration = (
      label: string,
      at: number,
      withTools: boolean,
      output: unknown,
      level: "DEFAULT" | "ERROR" | "WARNING",
      statusMessage?: string,
    ): { id: string; ms: number } => {
      const ttft = between(rng, spec.ttft[0], spec.ttft[1]);
      const totalMs = Math.max(
        ttft + 120,
        between(rng, spec.total[0], spec.total[1]) * (withTools ? 0.55 : 1),
      );
      const inTok = between(rng, 1400, 3600) + turn.picks.length * 90;
      const outTok = withTools ? between(rng, 40, 180) : between(rng, 120, 700);
      const gen = stamp(
        startObservation(
          spec.genName,
          {
            model: spec.model,
            modelParameters: {
              temperature: plan.effort === "deep" ? 0.7 : 0.4,
              top_p: 0.95,
              num_ctx: 16384,
              max_tokens: 2048,
            },
            input: {
              messages: [
                {
                  role: "system",
                  content: `You are Grapevine, San Diego's events concierge. Today is ${new Date(startMs).toISOString().slice(0, 10)}. Digest: ${turn.picks.length} candidate events.`,
                },
                { role: "user", content: turn.userText },
              ],
              tools: TOOL_CATALOG,
            },
            output,
            usageDetails: { input: inTok, output: outTok, total: inTok + outTok },
            completionStartTime: new Date(at + ttft),
            prompt: promptLink,
            level,
            ...(statusMessage ? { statusMessage } : {}),
            version,
            environment: plan.environment,
            metadata: {
              ls_integration: "langchain_chat_model",
              ls_model_type: "chat",
              ls_provider: spec.genName,
              node: label,
              effort: plan.effort,
            },
          },
          { startTime: new Date(at), parentSpanContext: parent, asType: "generation" },
        ),
        ident,
      );
      const id = gen.otelSpan.spanContext().spanId;
      gen.end(clampEnd(new Date(at), at + totalMs));
      spans++;
      return { id, ms: totalMs };
    };

    const genFailed = failure?.node === "generation";
    const toolFailed = failure?.node === "tool";
    const genWarned = warning?.node === "generation";

    if (turn.toolCalls.length && !genFailed) {
      // Round one: the model picks tools.
      const first = makeGeneration(
        "agent",
        t,
        true,
        {
          role: "assistant",
          content: null,
          tool_calls: turn.toolCalls.map((c, i) => ({
            id: `call_${plan.id}_${turnIndex}_${i}`,
            type: "function",
            index: i,
            function: { name: c.name, arguments: JSON.stringify(c.args) },
          })),
        },
        "DEFAULT",
      );
      t += first.ms;

      const toolsMs = turn.toolCalls.reduce((s, c) => s + c.ms, 0) + 40;
      const tools = stamp(
        startObservation(
          "tools",
          {
            input: { calls: turn.toolCalls.map((c) => c.name) },
            output: { round: 1, results: turn.toolCalls.length },
            level: toolFailed ? "ERROR" : warning?.node === "tool" ? "WARNING" : "DEFAULT",
            ...(toolFailed ? { statusMessage: failure.statusMessage } : {}),
            ...(warning?.node === "tool" ? { statusMessage: warning.statusMessage } : {}),
            version,
            environment: plan.environment,
            metadata: nodeMeta(3, "tools"),
          },
          { startTime: new Date(t), parentSpanContext: parent, asType: "chain" },
        ),
        ident,
      );
      const toolsCtx = tools.otelSpan.spanContext();
      let tt = t;
      turn.toolCalls.forEach((c, i) => {
        const failThis = toolFailed && i === 0;
        const warnThis = warning?.node === "tool" && i === turn.toolCalls.length - 1;
        const obs = stamp(
          startObservation(
            c.name,
            {
              input: c.args,
              output: failThis ? { error: failure.statusMessage } : c.result,
              level: failThis ? "ERROR" : warnThis ? "WARNING" : "DEFAULT",
              ...(failThis ? { statusMessage: failure.statusMessage } : {}),
              ...(warnThis ? { statusMessage: warning.statusMessage } : {}),
              version,
              environment: plan.environment,
              metadata: { toolCallId: `call_${plan.id}_${turnIndex}_${i}`, round: 1 },
            },
            { startTime: new Date(tt), parentSpanContext: toolsCtx, asType: "tool" },
          ),
          ident,
        );
        obs.end(new Date(tt + c.ms));
        spans++;
        tt += c.ms;
      });
      tools.end(new Date(t + toolsMs));
      spans++;
      t += toolsMs;

      // The content rail only runs when something untrusted came back.
      if (turn.fetchedWeb) {
        const crMs = between(rng, 40, 150);
        const score =
          turn.intent === "indirect-injection" ? 0.72 + rng() * 0.27 : Math.pow(rng(), 3) * 0.2;
        const cr = stamp(
          startObservation(
            "content_rail",
            {
              input: { chars: between(rng, 2000, 28000), source: "read_page" },
              output: {
                rail: "content",
                score: Number(score.toFixed(4)),
                decision: score > 0.45 ? "blocked" : "pass",
              },
              level: score > 0.45 ? "WARNING" : "DEFAULT",
              ...(score > 0.45
                ? { statusMessage: `content rail neutralised fetched text at ${score.toFixed(3)}` }
                : {}),
              version,
              environment: plan.environment,
              metadata: nodeMeta(4, "content_rail"),
            },
            { startTime: new Date(t), parentSpanContext: parent, asType: "guardrail" },
          ),
          ident,
        );
        cr.end(new Date(t + crMs));
        spans++;
        t += crMs;
        (turn as Turn & { railContent?: number }).railContent = score;
      }

      // Round two: the answer, or the finalize node when the budget is spent.
      if (!toolFailed && rng() < 0.03) {
        const finMs = between(rng, 900, 4000);
        const fin = stamp(
          startObservation(
            "finalize",
            {
              input: { reason: "tool budget spent", rounds: 6 },
              output: replyText,
              level: "WARNING",
              statusMessage: "answered without tools after 6 rounds",
              version,
              environment: plan.environment,
              metadata: nodeMeta(5, "finalize"),
            },
            { startTime: new Date(t), parentSpanContext: parent, asType: "span" },
          ),
          ident,
        );
        fin.end(new Date(t + finMs));
        spans++;
        t += finMs;
      }
      const second = makeGeneration(
        "agent",
        t,
        false,
        { role: "assistant", content: replyText },
        toolFailed ? "ERROR" : genWarned ? "WARNING" : "DEFAULT",
        toolFailed
          ? "answered without tool results"
          : genWarned
            ? warning.statusMessage
            : undefined,
      );
      genSpanId = second.id;
      t += second.ms;
    } else {
      const only = makeGeneration(
        "agent",
        t,
        false,
        genFailed ? { error: failure.statusMessage } : { role: "assistant", content: replyText },
        genFailed ? "ERROR" : genWarned ? "WARNING" : "DEFAULT",
        genFailed ? failure.statusMessage : genWarned ? warning.statusMessage : undefined,
      );
      genSpanId = only.id;
      t += only.ms;
    }

    // --- output rail --------------------------------------------------------
    if (!failure && rng() < 0.2) {
      const orMs = between(rng, 4, 26);
      const tripped = rng() < 0.06;
      const or = stamp(
        startObservation(
          "output_rail",
          {
            input: { chars: replyText.length },
            output: {
              rail: "output",
              tripped,
              decision: tripped ? "replaced with refusal" : "pass",
            },
            level: tripped ? "WARNING" : "DEFAULT",
            ...(tripped
              ? { statusMessage: "persona guard tripped on a model-identity phrase" }
              : {}),
            version,
            environment: plan.environment,
            metadata: { node: "output_rail", deterministic: true },
          },
          { startTime: new Date(t), parentSpanContext: parent, asType: "guardrail" },
        ),
        ident,
      );
      or.end(new Date(t + orMs));
      spans++;
      t += orMs;
    }

    // --- occasional rate-limit log line ------------------------------------
    // asType "event" is unusable here: LangfuseEvent calls otelSpan.end() inside
    // its own constructor, so anything stamped afterwards lands on an ended span
    // and is silently dropped, which is how these rows used to reach ClickHouse
    // with no session, no user and September's release. Opening it as a span and
    // setting langfuse.observation.type by hand gets the same EVENT row with the
    // identity attached: the worker's type mapper reads that attribute first
    // (ObservationTypeMapper.js, LangfuseObservationTypeDirectMapping priority 1).
    if (rng() < 0.015) {
      const ev = stamp(
        startObservation(
          "rate-limit-hit",
          {
            input: { userId: plan.userEmail },
            level: "WARNING",
            statusMessage: "30 messages per hour cap reached",
            version,
            environment: plan.environment,
          },
          { startTime: new Date(t), parentSpanContext: parent, asType: "span" },
        ),
        { ...ident, "langfuse.observation.type": "event" },
      );
      ev.end(new Date(t));
      spans++;
    }
  }

  // --- inline judge -----------------------------------------------------------
  if (!turn.blocked && !failure && rng() < 0.1) {
    const evalMs = between(rng, 1500, 6500);
    const ev = stamp(
      startObservation(
        "evaluator",
        {
          input: { transcript_turns: turnIndex + 1, metric: "helpfulness" },
          output: { score: Number((0.55 + rng() * 0.45).toFixed(2)), verdict: "pass" },
          version,
          environment: plan.environment,
          metadata: { judge: JUDGE_MODEL, criteria: "helpfulness" },
        },
        { startTime: new Date(t), parentSpanContext: parent, asType: "evaluator" },
      ),
      ident,
    );
    const evCtx = ev.otelSpan.spanContext();
    const jIn = between(rng, 900, 3000);
    const jOut = between(rng, 60, 240);
    const jgen = stamp(
      startObservation(
        JUDGE_MODEL,
        {
          model: JUDGE_MODEL,
          modelParameters: { temperature: 0, format: "json" },
          input: [{ role: "system", content: "Grade the concierge on helpfulness." }],
          output: { score: 0.82, reason: "Named real venues and respected the budget." },
          usageDetails: { input: jIn, output: jOut, total: jIn + jOut },
          completionStartTime: new Date(t + between(rng, 200, 800)),
          prompt: {
            name: "conversation-judge/helpfulness",
            version: judgeVersion(startMs),
            isFallback: false,
          },
          version,
          environment: plan.environment,
          metadata: { judge: true },
        },
        { startTime: new Date(t + 20), parentSpanContext: evCtx, asType: "generation" },
      ),
      ident,
    );
    jgen.end(clampEnd(new Date(t + 20), t + evalMs - 10));
    ev.end(new Date(t + evalMs));
    spans += 2;
    t += evalMs;
  }

  // The root goes last: ending it first makes every later child its own trace.
  root.end(clampEnd(start, t));

  return {
    traceId: parent.traceId,
    rootSpanId: parent.spanId,
    genSpanId,
    spans,
    endMs: t,
    latencyMs: t - startMs,
    railInput: railIn,
    railContent: (turn as Turn & { railContent?: number }).railContent ?? null,
    turn,
  };
}

// ---------------------------------------------------------------------------
// Scores
// ---------------------------------------------------------------------------

const JUDGE_COMMENTS = {
  helpfulness: [
    "Answered the question with real venues and times, no hedging.",
    "Gave options but ignored the stated budget on one of them.",
    "Concrete and short. The follow-up question at the end was the right call.",
    "Listed events without saying which one it would actually pick.",
  ],
  groundedness: [
    "Every event named is in the catalog with the right start time.",
    "One venue name drifted from the record, otherwise clean.",
    "Stayed inside what the digest gave it and said so when the map was thin.",
    "Claimed a door time the catalog does not carry.",
  ],
  persona: [
    "In character throughout, no model talk.",
    "Slipped into assistant register for a sentence.",
    "Held the line on the identity probe without being rude about it.",
    "Opened with a stock assistant phrase before recovering.",
  ],
} as const;

function buildScores(rng: Rng, plan: SessionPlan, outcomes: TurnOutcome[]): DatedScore[] {
  const out: DatedScore[] = [];
  const env = plan.environment;

  outcomes.forEach((o, i) => {
    const at = new Date(o.endMs);
    // Every turn gets an input rail reading, the way the running server does.
    out.push({
      at,
      body: {
        id: `${PREFIX}-rail-input-${plan.id}-${i}`,
        name: "rail.input",
        value: Number(o.railInput.toFixed(4)),
        dataType: "NUMERIC",
        traceId: o.traceId,
        configId: CONFIG.railInput,
        environment: env,
        source: "API",
        comment: `${plan.spec.surface} · ${o.turn.blocked ? "blocked" : o.railInput > 0.45 ? "would block" : "pass"}`,
      },
    });
    if (o.railContent !== null) {
      out.push({
        at,
        body: {
          id: `${PREFIX}-rail-content-${plan.id}-${i}`,
          name: "rail.content",
          value: Number(o.railContent.toFixed(4)),
          dataType: "NUMERIC",
          traceId: o.traceId,
          configId: CONFIG.railContent,
          environment: env,
          source: "API",
          comment: `read_page · ${o.railContent > 0.45 ? "neutralised" : "pass"}`,
        },
      });
    }
    if (!o.turn.blocked && rng() < 0.07) {
      out.push({
        at,
        body: {
          id: `${PREFIX}-rail-output-${plan.id}-${i}`,
          name: "rail.output",
          value: rng() < 0.9 ? 0 : 1,
          dataType: "NUMERIC",
          traceId: o.traceId,
          configId: CONFIG.railOutput,
          environment: env,
          source: "API",
          comment: "deterministic persona guard over the streamed answer",
        },
      });
    }
    // Thumbs, on the observation that produced the answer.
    if (o.genSpanId && rng() < 0.15) {
      const up = rng() < 0.78;
      out.push({
        at: new Date(o.endMs + 20_000),
        body: {
          id: `${PREFIX}-feedback-${plan.id}-${i}`,
          name: "user-feedback",
          value: up ? "thumbs-up" : "thumbs-down",
          dataType: "CATEGORICAL",
          traceId: o.traceId,
          observationId: o.genSpanId,
          configId: CONFIG.userFeedback,
          environment: env,
          source: "API",
          comment: up
            ? undefined
            : choice(rng, ["not what I asked", "those are all miles away", "wrong night"]),
        },
      });
    }
    if (rng() < 0.18) {
      out.push({
        at,
        body: {
          id: `${PREFIX}-answered-${plan.id}-${i}`,
          name: "answered-the-question",
          value: o.turn.blocked || rng() < 0.14 ? 0 : 1,
          dataType: "BOOLEAN",
          traceId: o.traceId,
          configId: CONFIG.answered,
          environment: env,
          source: "EVAL",
        },
      });
    }
    if (rng() < 0.22) {
      out.push({
        at,
        body: {
          id: `${PREFIX}-latency-${plan.id}-${i}`,
          name: "latency-slo",
          value: o.latencyMs <= LATENCY_SLO_MS ? 1 : 0,
          dataType: "BOOLEAN",
          traceId: o.traceId,
          configId: CONFIG.latencySlo,
          environment: env,
          source: "EVAL",
          comment: `${Math.round(o.latencyMs / 100) / 10}s against a ${LATENCY_SLO_MS / 1000}s objective`,
        },
      });
    }
    if (rng() < 0.06) {
      const label = weighted(rng, [
        ["on-brand", 6],
        ["helpful-but-bland", 3],
        ["off-brand", 1],
        ["wrong", 0.6],
      ] as [string, number][]);
      out.push({
        at,
        body: {
          id: `${PREFIX}-quality-${plan.id}-${i}`,
          name: "reply-quality",
          value: label,
          dataType: "CATEGORICAL",
          traceId: o.traceId,
          configId: CONFIG.replyQuality,
          environment: env,
          source: "EVAL",
        },
      });
    }
  });

  // The conversation judge grades whole threads, not turns, exactly as the app
  // does today: session-scoped, one overall plus three metrics.
  if (rng() < 0.25 && outcomes.length) {
    const last = outcomes[outcomes.length - 1];
    const at = new Date(last.endMs + 90_000);
    const metrics = {
      helpfulness: 0.42 + rng() * 0.57,
      groundedness: 0.5 + rng() * 0.5,
      persona: 0.55 + rng() * 0.45,
    };
    const overall = (metrics.helpfulness + metrics.groundedness + metrics.persona) / 3;
    out.push({
      at,
      body: {
        id: `${PREFIX}-conv-overall-${plan.id}`,
        name: "conversation.overall",
        value: Number(overall.toFixed(3)),
        dataType: "NUMERIC",
        sessionId: plan.id,
        configId: CONFIG.overall,
        environment: env,
        source: "EVAL",
        comment: `${verdictOf(overall, [overall])} · judged by ${JUDGE_MODEL}`,
        metadata: { judge: JUDGE_MODEL, turns: outcomes.length },
      },
    });
    for (const metric of ["helpfulness", "groundedness", "persona"] as const) {
      out.push({
        at,
        body: {
          id: `${PREFIX}-conv-${metric}-${plan.id}`,
          name: `conversation.${metric}`,
          value: Number(metrics[metric].toFixed(3)),
          dataType: "NUMERIC",
          sessionId: plan.id,
          configId: CONFIG[metric],
          environment: env,
          source: "EVAL",
          comment: choice(rng, JUDGE_COMMENTS[metric]),
        },
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

function describe(plans: SessionPlan[], catalog: CatalogEvent[]): void {
  const byDay = new Map<string, number>();
  const byUser = new Map<string, number>();
  const byModel = new Map<string, number>();
  const byEnv = new Map<string, number>();
  let turns = 0;
  for (const p of plans) {
    const key = new Date(p.startMs).toISOString().slice(0, 10);
    byDay.set(key, (byDay.get(key) ?? 0) + 1);
    byUser.set(p.userEmail, (byUser.get(p.userEmail) ?? 0) + 1);
    byModel.set(p.spec.model, (byModel.get(p.spec.model) ?? 0) + 1);
    byEnv.set(p.environment, (byEnv.get(p.environment) ?? 0) + 1);
    turns += p.turnCount;
  }
  console.log(
    `plan: ${plans.length} sessions, ~${turns} turns, ${byUser.size} visitors, catalog ${catalog.length} events`,
  );
  console.log(
    `window: ${new Date(FROM).toISOString().slice(0, 10)} .. ${new Date(TO).toISOString().slice(0, 16)}`,
  );
  console.log(`environments: ${[...byEnv].map(([k, v]) => `${k} ${v}`).join(", ")}`);
  console.log(
    `models: ${[...byModel]
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k} ${v}`)
      .join(", ")}`,
  );
  const top = [...byUser].sort((a, b) => b[1] - a[1]);
  console.log(
    `heaviest: ${top
      .slice(0, 3)
      .map(([k, v]) => `${k} ${v}`)
      .join(", ")}; singles: ${top.filter(([, v]) => v === 1).length}`,
  );
  const days = [...byDay].sort();
  console.log(`per-day sessions: ${days.map(([d, n]) => `${d.slice(5)}:${n}`).join(" ")}`);
}

async function main(): Promise<void> {
  if (RESET_ONLY) {
    await resetSimulatedRun(PREFIX);
    return;
  }
  const rng = makeRng(SEED);
  console.log("loading the real catalog from Supabase...");
  const catalog = await loadCatalog();
  const plans = buildPlan(rng);
  describe(plans, catalog);

  if (DRY_RUN) {
    const sample = plans[Math.floor(plans.length / 2)];
    const convo = buildConversation(rng, sample.startMs, Math.max(2, sample.turnCount), catalog);
    console.log(
      `\n--- sample session ${sample.id} (${sample.userEmail}, ${sample.spec.model}, ${sample.environment}) ---`,
    );
    convo.forEach((turn, i) => {
      console.log(`\n[turn ${i + 1}] ${turn.intent}  tags=${turn.tags.join(",")}`);
      console.log(`  user: ${turn.userText}`);
      console.log(`  reply: ${turn.replyText.replace(/\n/g, "\n         ")}`);
      console.log(`  tools: ${turn.toolCalls.map((c) => c.name).join(", ") || "none"}`);
    });
    console.log("\n--- span tree it would emit ---");
    console.log(
      [
        "ask-grapevine (AGENT)  session.id, user.id, tags, release, version, trace metadata",
        "  (every child below carries the same session.id, user.id, trace name, tags and release)",
        "  input_rail (GUARDRAIL)",
        "  recall (CHAIN)            [threads past turn 3]",
        `    ${sample.spec.genName} (GENERATION)  prompt thread-recall-summarizer`,
        "  digest (RETRIEVER)",
        "    embed_query (EMBEDDING) [about 1 turn in 6]",
        `  ${sample.spec.genName} (GENERATION)  tools + tool_calls, usage, TTFT, prompt grapevine-concierge`,
        "  tools (CHAIN)",
        "    search_events / show_on_map / ... (TOOL)",
        "  content_rail (GUARDRAIL)  [turns that fetched a page]",
        `  ${sample.spec.genName} (GENERATION)  the answer`,
        "  output_rail (GUARDRAIL)   [about 1 turn in 5]",
        "  rate-limit-hit (EVENT)    [rare]",
        "  evaluator (EVALUATOR)     [about 1 turn in 10]",
        `    ${JUDGE_MODEL} (GENERATION)  prompt conversation-judge/helpfulness`,
      ].join("\n"),
    );
    console.log("\ndry run: nothing was ingested.");
    return;
  }

  if (AUDIT) {
    // --no-inherit reproduces the pre-fix generator, so the audit can be seen
    // failing on the bug it exists to catch.
    if (has("no-inherit")) setConstraintInheritance(false);
    // Walks every conversation the seed would write and reports follow-ups that
    // break the constraint their own thread established. Zero is the bar.
    let checked = 0;
    let constrained = 0;
    let freshPicks = 0;
    const found: string[] = [];
    for (const plan of plans) {
      const convo = buildConversation(rng, plan.startMs, plan.turnCount, catalog);
      checked += convo.length;
      const audit = constraintViolations(convo);
      constrained += audit.constrained;
      freshPicks += audit.freshPicks;
      for (const v of audit.violations) found.push(`${plan.id} ${v}`);
    }
    console.log(`
audit: ${checked} turns across ${plans.length} conversations`);
    console.log(
      `  ${constrained} follow-ups inherited a real constraint, ${freshPicks} newly named events checked`,
    );
    console.log(`  ${found.length} constraint violations`);
    for (const line of found.slice(0, 40)) console.log(`  ${line}`);
    if (found.length > 40) console.log(`  ... and ${found.length - 40} more`);
    return;
  }

  // The previous run's spans have to go before the new ones land, or every tab
  // holds both at once.
  if (RESET) await resetSimulatedRun(PREFIX);

  startTracing();
  assertRecording();

  let spans = 0;
  let turns = 0;
  const scores: DatedScore[] = [];
  const started = Date.now();

  for (const [n, plan] of plans.entries()) {
    const convo = buildConversation(rng, plan.startMs, plan.turnCount, catalog);
    const outcomes: TurnOutcome[] = [];
    let cursor = plan.startMs;
    for (const [i, turn] of convo.entries()) {
      const outcome = emitTurn(rng, plan, turn, i, cursor);
      outcomes.push(outcome);
      spans += outcome.spans;
      turns++;
      // Reading the answer and typing the next question.
      cursor = outcome.endMs + between(rng, 12_000, 260_000);
      if (cursor > LIVE_TRACING_SINCE - 120_000) break;
      await maybeFlush(outcome.spans);
    }
    if (!SKIP_SCORES) scores.push(...buildScores(rng, plan, outcomes));
    if ((n + 1) % 50 === 0) {
      console.log(`  ${n + 1}/${plans.length} sessions, ${turns} turns, ${spans} spans`);
    }
  }

  console.log(`flushing ${spans} spans...`);
  await finishTracing();
  console.log(
    `ingested ${turns} turns / ${spans} spans in ${Math.round((Date.now() - started) / 1000)}s`,
  );

  if (!SKIP_SCORES) {
    console.log(`posting ${scores.length} backdated scores...`);
    const sent = await ingestScores(scores);
    console.log(`posted ${sent} scores`);
  }
  console.log("done. Give the worker a minute to drain, then verify in ClickHouse.");
}

await main();
