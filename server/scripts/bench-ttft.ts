/**
 * Time to first token, measured the way a person meets it.
 *
 *   npm run bench:ttft -w server -- [--base-url URL] [--runtime ollama|openai]
 *     [--model NAME] [--samples 100] [--cold 3] [--gap-ms 2000]
 *     [--scenario short,long,long-miss] [--out report.json]
 *
 * Reports TTFT, TPOT (time per output token: (last - first) / (tokens - 1)),
 * end-to-end latency and output tokens per second, each at p50, p95 and p99, one
 * request at a time. Two levels, named so they cannot be mixed up:
 *
 *  - model:   request sent to the runtime until its first generated token,
 *             timed inside the Python gate where the tokens arrive.
 *  - visible: POST /api/agent/chat until the first `delta` frame reaches this
 *             client, over a real socket through the real chat route, graph,
 *             rails and gate.
 *
 * Warm samples rotate through fixed questions and wait --gap-ms between turns,
 * because a person reads an answer before asking again and the worker's idle
 * behavior is part of what they wait for. A cold sample unloads the model first.
 * Turns that ran a tool before answering are reported apart, because a tool round
 * delays the first answer token by design.
 *
 * Scenarios:
 *  - short:     the fixture catalog, 15 events.
 *  - long:      120 events (the digest limit), prefix cache allowed to hit.
 *  - long-miss: the same, with the soonest listing changed every turn, which is
 *               what a new event does to the cache.
 *
 * What is not measured: the database. The store is a fixture and this process has
 * placeholder credentials and the eval network block, so no real data is reachable
 * and a deployment's Supabase round trips are not in the visible numbers. Run it
 * with nothing else on the GPU; a bench under contention measures the contention.
 *
 * --runtime openai skips the app and streams the same messages straight at an
 * OpenAI-compatible endpoint (vLLM, for one), so there is no visible level. The
 * targets printed are MLPerf's Llama 3.1 8B interactive latency limits, used as a
 * yardstick; this is not an MLPerf submission or a certified result.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { cpus } from "node:os";
import { benchCatalog, withNonce } from "./bench-fixture.js";
import { percentile } from "../src/evals/stats.js";
import { CONTRACT_VERSION } from "../src/llm/generated.js";

const argv = process.argv.slice(2);
const arg = (name: string, fallback: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const baseUrl = arg("base-url", process.env.OLLAMA_URL || "http://127.0.0.1:11434").replace(
  /\/$/,
  "",
);
const runtime = arg("runtime", "ollama");
const model = arg("model", "qwen3.8:27b");
const samples = Number(arg("samples", "100"));
const coldSamples = Number(arg("cold", "3"));
const gapMs = Number(arg("gap-ms", "2000"));
const scenarios = arg("scenario", "short,long,long-miss").split(",");
const out = arg("out", "");

// Before anything that reads the environment at import time.
process.env.SUPABASE_URL = "https://bench.invalid";
process.env.SUPABASE_SECRET_KEY = "bench-placeholder";
process.env.MAPBOX_SECRET_TOKEN = "bench-placeholder";
process.env.OLLAMA_URL = baseUrl;
process.env.LOG_LEVEL ??= "silent";

export const LIMITS = { ttftMs: 500, tpotMs: 30 };

const QUESTIONS = [
  "What should I do tonight?",
  "Anything free this weekend?",
  "Is there live music on Saturday?",
  "What's good for a family with kids this weekend?",
  "Any comedy shows coming up?",
  "What's on at the Rady Shell?",
  "Are there any farmers markets this week?",
  "What's the priciest thing on this week?",
  "Hi, what can you help me with?",
  "What time is it, and what day?",
];

interface Sample {
  question: string;
  toolFirst: boolean;
  visibleTtftMs: number | null;
  visibleTpotMs: number | null;
  e2eMs: number;
  modelTtftMs: number | null;
  /** First word of the answer text, a few tokens after the JSON envelope opens. */
  modelAnswerTtftMs: number | null;
  modelTpotMs: number | null;
  outputTokens: number | null;
  promptTokens: number | null;
  retracted: boolean;
  error: string | null;
}

export function percentiles(values: (number | null)[]) {
  const seen = values.filter((v): v is number => typeof v === "number");
  return {
    n: seen.length,
    p50: percentile(seen, 50),
    p95: percentile(seen, 95),
    p99: percentile(seen, 99),
  };
}

export function summarize(rows: Sample[], fullPromptTokens: number | null) {
  const ok = rows.filter((r) => !r.error);
  const rate = (r: Sample) =>
    r.outputTokens && r.e2eMs ? (r.outputTokens * 1000) / r.e2eMs : null;
  const evaluated = ok.map((r) => r.promptTokens).filter((v): v is number => v !== null);
  return {
    samples: rows.length,
    errors: rows.length - ok.length,
    retractions: ok.filter((r) => r.retracted).length,
    model_ttft_ms: percentiles(ok.map((r) => r.modelTtftMs)),
    model_answer_ttft_ms: percentiles(ok.map((r) => r.modelAnswerTtftMs)),
    model_tpot_ms: percentiles(ok.map((r) => r.modelTpotMs)),
    visible_ttft_ms: percentiles(ok.map((r) => r.visibleTtftMs)),
    visible_tpot_ms: percentiles(ok.map((r) => r.visibleTpotMs)),
    e2e_ms: percentiles(ok.map((r) => r.e2eMs)),
    output_tokens_per_s: percentiles(ok.map(rate)),
    prompt_tokens_evaluated: percentiles(evaluated),
    prompt_tokens_full: fullPromptTokens,
    // What share of the prompt the runtime did not have to evaluate again.
    cache_hit_rate:
      fullPromptTokens && evaluated.length
        ? 1 - evaluated.reduce((a, b) => a + b, 0) / evaluated.length / fullPromptTokens
        : null,
  };
}

function machine() {
  const run = (cmd: string, args: string[]) => {
    try {
      return execFileSync(cmd, args, { encoding: "utf8", timeout: 10_000 }).trim();
    } catch {
      return "unknown";
    }
  };
  return {
    gpu: run("nvidia-smi", ["--query-gpu=name,memory.total", "--format=csv,noheader"]),
    cpu: cpus()[0]?.model ?? "unknown",
    logical_cpus: cpus().length,
    platform: process.platform,
    concurrency: 1,
  };
}

async function runtimeFacts() {
  const facts: Record<string, unknown> = { runtime, base_url: baseUrl, model };
  try {
    const version = (await (await fetch(`${baseUrl}/api/version`)).json()) as { version?: string };
    const tags = (await (await fetch(`${baseUrl}/api/tags`)).json()) as {
      models?: { name: string; digest: string }[];
    };
    facts.runtime_version = version.version;
    facts.model_digest = tags.models?.find((m) => m.name === model)?.digest;
  } catch {
    /* an OpenAI-compatible runtime need not answer these */
  }
  return facts;
}

async function unload(): Promise<void> {
  await fetch(`${baseUrl}/api/generate`, {
    method: "POST",
    body: JSON.stringify({ model, keep_alive: 0 }),
  }).catch(() => {});
  await new Promise((r) => setTimeout(r, 1500));
}

/** The same turn through the real route, timed from the client's side of the socket. */
async function chatTurn(url: string, question: string, threadId: string): Promise<Sample> {
  const t0 = performance.now();
  const blank: Sample = {
    question,
    toolFirst: false,
    visibleTtftMs: null,
    visibleTpotMs: null,
    e2eMs: 0,
    modelTtftMs: null,
    modelAnswerTtftMs: null,
    modelTpotMs: null,
    outputTokens: null,
    promptTokens: null,
    retracted: false,
    error: null,
  };
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ threadId, message: question }),
  });
  if (res.status === 429) {
    const wait = Number(res.headers.get("retry-after") ?? 5);
    await new Promise((r) => setTimeout(r, (wait + 1) * 1000));
    return chatTurn(url, question, threadId);
  }
  if (!res.ok || !res.body) return { ...blank, error: `HTTP ${res.status}` };

  const row = { ...blank };
  let firstDelta: number | null = null;
  let lastDelta: number | null = null;
  let deltas = 0;
  let buffer = "";
  const decoder = new TextDecoder();
  const handle = (line: string) => {
    if (!line.trim()) return;
    const frame = JSON.parse(line) as {
      type: string;
      message?: string;
      state?: string;
      usage?: {
        inputTokens?: number;
        outputTokens?: number;
        modelTtftMs?: number;
        modelAnswerTtftMs?: number;
        tpotMs?: number;
      };
    };
    const now = performance.now();
    if (frame.type === "tool" && firstDelta === null) row.toolFirst = true;
    if (frame.type === "delta") {
      firstDelta ??= now;
      lastDelta = now;
      deltas++;
    }
    if (frame.type === "replace") row.retracted = true;
    if (frame.type === "error") row.error = frame.message ?? "error";
    if (frame.type === "usage" && frame.usage) {
      // A later model call in the turn wins: that is the one that wrote the answer.
      row.modelTtftMs = frame.usage.modelTtftMs ?? row.modelTtftMs;
      row.modelAnswerTtftMs = frame.usage.modelAnswerTtftMs ?? row.modelAnswerTtftMs;
      row.modelTpotMs = frame.usage.tpotMs ?? row.modelTpotMs;
      row.outputTokens = frame.usage.outputTokens ?? row.outputTokens;
      row.promptTokens = frame.usage.inputTokens ?? row.promptTokens;
    }
  };
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let end: number;
    while ((end = buffer.indexOf("\n")) >= 0) {
      handle(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
    }
  }
  handle(buffer);
  row.e2eMs = performance.now() - t0;
  row.visibleTtftMs = firstDelta === null ? null : firstDelta - t0;
  // Interval between frames as they reached this client. With a whole-answer gate
  // there is one frame, and so no interval to report.
  if (firstDelta !== null && lastDelta !== null && deltas > 1) {
    row.visibleTpotMs = (lastDelta - firstDelta) / (deltas - 1);
  }
  return row;
}

/** Straight at an OpenAI-compatible endpoint, for runtimes the app is not yet wired to. */
async function directTurn(messages: { role: string; content: string }[]): Promise<Sample> {
  const t0 = performance.now();
  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      messages,
      stream: true,
      stream_options: { include_usage: true },
      temperature: 0,
      seed: 42,
      max_tokens: 4096,
    }),
  });
  const question = messages.at(-1)?.content ?? "";
  const row: Sample = {
    question,
    toolFirst: false,
    visibleTtftMs: null,
    visibleTpotMs: null,
    e2eMs: 0,
    modelTtftMs: null,
    modelAnswerTtftMs: null,
    modelTpotMs: null,
    outputTokens: null,
    promptTokens: null,
    retracted: false,
    error: null,
  };
  if (!res.ok || !res.body) return { ...row, error: `HTTP ${res.status}` };
  let first: number | null = null;
  let last: number | null = null;
  let chunks = 0;
  let buffer = "";
  const decoder = new TextDecoder();
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let end: number;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end).trim();
      buffer = buffer.slice(end + 1);
      if (!line.startsWith("data:") || line.includes("[DONE]")) continue;
      const data = JSON.parse(line.slice(5)) as {
        choices?: { delta?: { content?: string } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      if (data.choices?.[0]?.delta?.content) {
        first ??= performance.now();
        last = performance.now();
        chunks++;
      }
      if (data.usage) {
        row.promptTokens = data.usage.prompt_tokens ?? null;
        row.outputTokens = data.usage.completion_tokens ?? null;
      }
    }
  }
  row.e2eMs = performance.now() - t0;
  row.modelTtftMs = first === null ? null : first - t0;
  const count = row.outputTokens ?? chunks;
  if (first !== null && last !== null && count > 1) row.modelTpotMs = (last - first) / (count - 1);
  return row;
}

function report(label: string, s: ReturnType<typeof summarize>): void {
  const fmt = (p: { n: number; p50: number | null; p95: number | null; p99: number | null }) =>
    p.n ? `${p.p50?.toFixed(0)} / ${p.p95?.toFixed(0)} / ${p.p99?.toFixed(0)}` : "n/a";
  console.error(
    `\n${label} (${s.samples} samples, ${s.errors} errors, ${s.retractions} retracted)`,
  );
  console.error(`  model TTFT ms   p50/p95/p99  ${fmt(s.model_ttft_ms)}`);
  console.error(`  first answer ms p50/p95/p99  ${fmt(s.model_answer_ttft_ms)}`);
  console.error(`  model TPOT ms   p50/p95/p99  ${fmt(s.model_tpot_ms)}`);
  console.error(`  visible TTFT ms p50/p95/p99  ${fmt(s.visible_ttft_ms)}`);
  console.error(`  visible TPOT ms p50/p95/p99  ${fmt(s.visible_tpot_ms)}`);
  console.error(`  end to end ms   p50/p95/p99  ${fmt(s.e2e_ms)}`);
  console.error(`  output tok/s    p50/p95/p99  ${fmt(s.output_tokens_per_s)}`);
  console.error(
    `  prompt tokens evaluated p50 ${s.prompt_tokens_evaluated.p50 ?? "n/a"}, full ${s.prompt_tokens_full ?? "n/a"}, cache hit rate ${s.cache_hit_rate === null ? "n/a" : `${(s.cache_hit_rate * 100).toFixed(1)}%`}`,
  );
}

async function main(): Promise<void> {
  // Imported here so the placeholders above win over anything these read at load.
  const [{ default: express }, { store }, { chat }, fixtures, { buildSystemPrompt }] =
    await Promise.all([
      import("express"),
      import("../src/store.js"),
      import("../src/agent/chat.js"),
      import("../src/evals/fixtures.js"),
      import("../src/agent/context.js"),
    ]);

  const results: Record<string, unknown> = {};
  const facts = { ...machine(), ...(await runtimeFacts()) };
  console.error(JSON.stringify(facts));

  if (runtime === "openai") {
    // No gate here, so the schema is sent as text ahead of the prompt, as the gate
    // sends it, and the runtime's constrained decoding is not exercised.
    const schema = readFileSync(
      new URL(`../../contracts/llm/${CONTRACT_VERSION}/agent.json`, import.meta.url),
      "utf8",
    );
    for (const name of scenarios) {
      const ctx = fixtures.fixtureCtx({ events: name === "short" ? undefined : benchCatalog(120) });
      const evidence = ctx.upcoming.map(({ e, occ }) => ({
        id: e.id,
        text: JSON.stringify({ ...e, ...occ }),
      }));
      const rows: Sample[] = [];
      for (let i = 0; i < samples; i++) {
        rows.push(
          await directTurn([
            { role: "system", content: `Return exactly the requested JSON schema.\n${schema}` },
            { role: "system", content: `Evidence: ${JSON.stringify(evidence)}` },
            { role: "system", content: buildSystemPrompt(ctx, {}, false) },
            { role: "user", content: QUESTIONS[i % QUESTIONS.length] },
          ]),
        );
      }
      const s = summarize(rows, null);
      report(name, s);
      results[name] = { warm: s, rows };
    }
  } else {
    let catalog = benchCatalog(15);
    const stored = store as unknown as Record<string, unknown>;
    stored.settings = async () => ({
      ...fixtures.FIXTURE_SETTINGS,
      model,
      ollamaUrl: baseUrl,
    });
    stored.events = async () => catalog;
    stored.chatThreadOwner = async () => null;

    const app = express();
    app.use(express.json());
    app.use(chat);
    const server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/agent/chat`;

    for (const name of scenarios) {
      const base = name === "short" ? benchCatalog(15) : benchCatalog(120);
      catalog = base;

      // Cold first: it also gives the full prompt size, since nothing is cached.
      const cold: Sample[] = [];
      for (let i = 0; i < coldSamples; i++) {
        await unload();
        cold.push(await chatTurn(url, QUESTIONS[0], crypto.randomUUID()));
        console.error(`${name} cold ${i + 1}: ${cold.at(-1)?.visibleTtftMs?.toFixed(0)} ms`);
      }
      const full = Math.max(0, ...cold.map((r) => r.promptTokens ?? 0)) || null;

      const warm: Sample[] = [];
      // One throwaway turn so the first warm sample is not the worker's cold start.
      await chatTurn(url, QUESTIONS[0], crypto.randomUUID());
      for (let i = 0; i < samples; i++) {
        await new Promise((r) => setTimeout(r, gapMs));
        if (name === "long-miss") catalog = withNonce(base, i);
        warm.push(await chatTurn(url, QUESTIONS[i % QUESTIONS.length], crypto.randomUUID()));
        if ((i + 1) % 10 === 0) console.error(`${name} warm ${i + 1}/${samples}`);
      }
      const noTool = warm.filter((r) => !r.toolFirst);
      const toolFirst = warm.filter((r) => r.toolFirst);
      const summary = {
        cold: summarize(cold, full),
        warm_no_tool: summarize(noTool, full),
        warm_tool_first: summarize(toolFirst, full),
      };
      report(`${name} cold`, summary.cold);
      report(`${name} warm, no tool`, summary.warm_no_tool);
      report(`${name} warm, tool first`, summary.warm_tool_first);
      results[name] = { ...summary, rows: warm, cold_rows: cold };
    }
    server.close();
  }
  const payload = {
    facts,
    limits: {
      source: "MLPerf Llama 3.1 8B interactive latency limits, used as a yardstick",
      ...LIMITS,
    },
    gap_ms: gapMs,
    results,
  };
  if (out) writeFileSync(out, JSON.stringify(payload, null, 2) + "\n");
  console.log(
    JSON.stringify(payload, (k, v) => (k === "rows" || k === "cold_rows" ? undefined : v), 2),
  );
  process.exit(0);
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/bench-ttft.ts")) {
  await main();
}
