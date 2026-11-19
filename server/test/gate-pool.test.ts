/**
 * The gate's worker pool, with the Python processes replaced by stand-ins this test
 * drives by hand. What is under test is the plumbing around the scheduler: which
 * process gets which request, and that stopping one request stops only that one.
 */
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

class FakeWorker extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
  requests: { id: string; task: string }[] = [];
  constructor() {
    super();
    let buffer = "";
    this.stdin.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        this.requests.push(JSON.parse(buffer.slice(0, end)));
        buffer = buffer.slice(end + 1);
      }
    });
  }
  ref() {}
  unref() {}
  kill() {
    this.killed = true;
    queueMicrotask(() => this.emit("exit", null));
    return true;
  }
  /** Answer the request this worker is holding. */
  reply(output: unknown = RATING) {
    const { id } = this.requests.at(-1)!;
    this.stdout.write(
      JSON.stringify({ ok: true, id, version: "1.4.0", output, stats: STATS }) + "\n",
    );
  }
}

const RATING = { rating: 4, rationale: "Local jazz", promoted: false };
const STATS = {
  attempts: 1,
  validation_failures: 0,
  first_pass: true,
  validation_ms: 1,
  total_ms: 5,
  repair_ms: 0,
};
const spawned: FakeWorker[] = [];

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: () => {
    const worker = new FakeWorker();
    spawned.push(worker);
    return worker;
  },
}));

const { generateTyped, gateSnapshot, stopGate } = await import("../src/llm/gateway.js");
const { setProbe } = await import("../src/llm/admission.js");

const saved = { ...process.env };
const rate = (opts: Partial<Parameters<typeof generateTyped>[0]> = {}) =>
  generateTyped({ task: "rating", messages: [{ role: "user", content: "Rate jazz" }], ...opts });
/** The workers holding a request right now. */
const busy = () => spawned.filter((w) => !w.killed && w.requests.length > 0);
const holding = async (count: number) =>
  vi.waitFor(() => expect(spawned.reduce((n, w) => n + w.requests.length, 0)).toBe(count));

beforeEach(() => {
  spawned.length = 0;
  process.env.GRAPEVINE_LLM_ADMISSION = "off";
  delete process.env.GRAPEVINE_LLM_RUNTIME;
});
afterEach(() => {
  stopGate();
  setProbe(null);
  process.env = { ...saved };
});

it("runs as many generations at once as the limit allows and queues the rest", async () => {
  process.env.GRAPEVINE_LLM_CONCURRENCY = "2";
  const results = [rate(), rate(), rate()];
  await holding(2);
  expect(gateSnapshot()).toMatchObject({
    concurrency: 2,
    running: { interactive: 2, background: 0 },
    queued: { interactive: 1, background: 0 },
  });
  spawned[0].reply();
  // The freed worker takes the queued request: no third process is started for it.
  await holding(3);
  expect(spawned).toHaveLength(2);
  expect(spawned[0].requests).toHaveLength(2);
  spawned[0].reply();
  spawned[1].reply();
  expect(await Promise.all(results)).toEqual([RATING, RATING, RATING]);
});

it("stops a background generation to let a person through, then runs it again", async () => {
  // Ollama's default: one generation at a time.
  const inbox = rate({ priority: "background" });
  await holding(1);
  const [first, standby] = spawned;
  // A second worker is already imported and waiting for exactly this.
  expect(standby.requests).toHaveLength(0);

  const chat = rate();
  await vi.waitFor(() => expect(standby.requests).toHaveLength(1));
  expect(first.killed).toBe(true);
  expect(gateSnapshot()).toMatchObject({
    running: { interactive: 1, background: 0 },
    queued: { interactive: 0, background: 1 },
    preemptions: expect.any(Number),
  });

  standby.reply();
  expect(await chat).toEqual(RATING);
  // The stopped job starts over on the free worker and completes normally.
  await vi.waitFor(() => expect(standby.requests).toHaveLength(2));
  expect(standby.requests[1].id).toBe(first.requests[0].id);
  standby.reply();
  expect(await inbox).toEqual(RATING);
});

it("cancelling one request stops its own worker and no other", async () => {
  process.env.GRAPEVINE_LLM_CONCURRENCY = "2";
  const abort = new AbortController();
  const cancelled = rate({ signal: abort.signal });
  const other = rate();
  await holding(2);
  abort.abort();
  await expect(cancelled).rejects.toMatchObject({ code: "cancelled" });
  expect(spawned[0].killed).toBe(true);
  expect(spawned[1].killed).toBe(false);
  spawned[1].reply();
  expect(await other).toEqual(RATING);
});

it("a worker that breaks the protocol fails its own request only", async () => {
  process.env.GRAPEVINE_LLM_CONCURRENCY = "2";
  const broken = rate();
  const fine = rate();
  await holding(2);
  spawned[0].stdout.write("not json\n");
  await expect(broken).rejects.toMatchObject({ code: "protocol" });
  spawned[1].reply();
  expect(await fine).toEqual(RATING);
});

it("says busy when a queue is full, and when a person has waited too long", async () => {
  process.env.GRAPEVINE_LLM_QUEUE_INTERACTIVE = "1";
  process.env.GRAPEVINE_LLM_QUEUE_WAIT_INTERACTIVE_MS = "150";
  const running = rate();
  await holding(1);
  const waiting = rate();
  await expect(rate()).rejects.toMatchObject({ code: "busy", message: "LLM gate queue is full" });
  // Nothing frees the slot, so the queued request gives up on its own.
  await expect(waiting).rejects.toMatchObject({ code: "busy" });
  expect(busy()).toHaveLength(1);
  spawned[0].reply();
  expect(await running).toEqual(RATING);
});

it("holds background work while the runtime reports no headroom, then lets it go", async () => {
  delete process.env.GRAPEVINE_LLM_ADMISSION;
  const load = { running: 3, waiting: 0, kvCacheUsage: 0.97, gpuFreeMiB: null, coldLoadMiB: null };
  setProbe(async () => load);
  const inbox = rate({
    priority: "background",
    baseUrl: "http://127.0.0.1:8000",
    model: "qwen3.8-27b-int4",
  });
  await vi.waitFor(() => expect(gateSnapshot().backgroundDeferrals).toBeGreaterThan(0));
  expect(spawned).toHaveLength(0);
  expect(gateSnapshot().runtimeLoad).toMatchObject({ admitted: false, reason: "kv-cache" });

  // A person is not held by the same reading.
  const chat = rate();
  await holding(1);
  spawned[0].reply();
  expect(await chat).toEqual(RATING);

  load.kvCacheUsage = 0.2;
  await vi.waitFor(() => expect(spawned[0].requests).toHaveLength(2), { timeout: 4000 });
  spawned[0].reply();
  expect(await inbox).toEqual(RATING);
});

it("fails everything in flight when the gate is stopped", async () => {
  const running = rate();
  const queued = rate();
  await holding(1);
  stopGate();
  await expect(running).rejects.toMatchObject({ code: "unavailable" });
  await expect(queued).rejects.toMatchObject({ code: "unavailable" });
  expect(spawned.every((w) => w.killed)).toBe(true);
});
