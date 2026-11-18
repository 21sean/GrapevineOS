import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { backgroundAdmission, lastLoad, refresh, type Target } from "./admission.js";
import {
  CONTRACT_VERSION,
  outputSchemas,
  requestSchema,
  result_envelopeSchema,
  stream_frameSchema,
  type LlmStats,
  type Output,
  type Task,
  type ValidationContext,
} from "./generated.js";
import { llmRuntime, type LlmRuntime } from "./runtime.js";
import { Scheduler, type Limits, type Priority, type Ticket } from "./scheduler.js";

export type { Priority } from "./scheduler.js";

export class LlmGateError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "LlmGateError";
  }
}
const envelope = result_envelopeSchema;
const root = fileURLToPath(new URL("../../..", import.meta.url));
const python =
  process.env.GRAPEVINE_LLM_PYTHON ||
  fileURLToPath(
    new URL(
      process.platform === "win32"
        ? "../../../llm/.venv/Scripts/python.exe"
        : "../../../llm/.venv/bin/python",
      import.meta.url,
    ),
  );

/**
 * The gate is a pool of Python workers, each validating one generation at a time.
 * One worker per generation keeps the fail-closed property simple: cancelling or
 * timing out a request kills exactly its own process, and nothing a request does can
 * reach another request's output. How many run at once, and in what order, is the
 * scheduler's decision (scheduler.ts); whether background work may start is the
 * runtime's (admission.ts).
 */
interface Job {
  id: string;
  line: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  onStats?: (stats: LlmStats) => void;
  onDelta?: (text: string) => void;
  onReset?: () => void;
  /** Detach from the caller's AbortSignal. */
  release: () => void;
  /** Answer text is on the caller's screen and has not been taken back. */
  shown: boolean;
  /** The queue-wait limit while queued, the generation deadline while running. */
  timer?: ReturnType<typeof setTimeout>;
  ticket?: Ticket<Job>;
  worker?: GateWorker;
}

interface GateWorker {
  child: ChildProcessWithoutNullStreams;
  buffer: string;
  job: Job | null;
  idle?: ReturnType<typeof setTimeout>;
  /** Retired on purpose: its exit is not a failure to report. */
  retired: boolean;
}

const scheduler = new Scheduler<Job>();
const workers = new Set<GateWorker>();
const counters = { preemptions: 0, busy: 0, deferred: 0 };
let backgroundTarget: Target | null = null;
let recheck: ReturnType<typeof setTimeout> | undefined;

/**
 * How long a worker outlives its last request. Python takes about two seconds to
 * import the gate, and a person reads an answer for longer than a second, so a short
 * idle spends those two seconds on nearly every chat turn.
 */
const WORKER_IDLE_MS = Number(process.env.GRAPEVINE_LLM_WORKER_IDLE_MS) || 600_000;

/** One generation, from dispatch to result. The worker's own limit is 120 s. */
const RUN_DEADLINE_MS = 125_000;

function envInt(name: string, fallback: number, min: number, max: number): number {
  const value = Number(process.env[name]);
  if (!process.env[name] || !Number.isInteger(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/**
 * Generations handed to each runtime at once when nothing is configured. Ollama
 * serves requests in turn, so a second one would only wait inside it where the gate
 * cannot reorder it. vLLM batches, alone or behind Triton; llm/README.md has the
 * measurements to tune this number against.
 */
const DEFAULT_CONCURRENCY: Record<LlmRuntime, number> = { ollama: 1, vllm: 4, triton: 4 };

export function gateLimits(): Limits {
  let runtime: LlmRuntime = "ollama";
  try {
    runtime = llmRuntime();
  } catch {
    /* the request reports the bad runtime; the limits only need a number */
  }
  const concurrency = envInt("GRAPEVINE_LLM_CONCURRENCY", DEFAULT_CONCURRENCY[runtime], 1, 32);
  return {
    concurrency,
    // One slot stays free for a person whenever there is more than one.
    backgroundSlots: envInt(
      "GRAPEVINE_LLM_BACKGROUND_SLOTS",
      Math.max(1, concurrency - 1),
      1,
      concurrency,
    ),
    maxQueued: {
      interactive: envInt("GRAPEVINE_LLM_QUEUE_INTERACTIVE", 16, 1, 256),
      background: envInt("GRAPEVINE_LLM_QUEUE_BACKGROUND", 64, 1, 1024),
    },
    maxPreemptions: envInt("GRAPEVINE_LLM_MAX_PREEMPTIONS", 2, 0, 10),
  };
}

/**
 * How long a request may wait for a slot. A person is better served by "busy, try
 * again" than by a spinner; the inbox can wait, and retries what it gives up on.
 */
function queueWaitMs(priority: Priority): number {
  return priority === "interactive"
    ? envInt("GRAPEVINE_LLM_QUEUE_WAIT_INTERACTIVE_MS", 30_000, 100, 600_000)
    : envInt("GRAPEVINE_LLM_QUEUE_WAIT_BACKGROUND_MS", 600_000, 100, 3_600_000);
}

/** An idle worker must not keep a script alive, and a busy one must. */
function holdProcess(child: ChildProcessWithoutNullStreams, hold: boolean): void {
  const method = hold ? "ref" : "unref";
  child[method]();
  for (const stream of [child.stdin, child.stdout, child.stderr]) {
    (stream as unknown as Record<string, (() => void) | undefined>)[method]?.();
  }
}

function retire(worker: GateWorker): void {
  worker.retired = true;
  clearTimeout(worker.idle);
  workers.delete(worker);
  worker.child.kill();
}

/** End a job exactly once, whatever state it was in. */
function settle(job: Job, outcome: (job: Job) => void): void {
  clearTimeout(job.timer);
  job.release();
  outcome(job);
}

/** This worker cannot be trusted any more: stop it and fail what it was doing. */
function fail(worker: GateWorker, error: LlmGateError): void {
  if (worker.retired) return;
  const job = worker.job;
  worker.job = null;
  retire(worker);
  if (job?.ticket) {
    scheduler.finish(job.ticket);
    settle(job, (j) => j.reject(error));
  }
  pump();
}

function rest(worker: GateWorker): void {
  holdProcess(worker.child, false);
  worker.idle = setTimeout(() => retire(worker), WORKER_IDLE_MS).unref();
}

function spawnWorker(): GateWorker {
  const child = spawn(python, ["-m", "grapevine_llm.worker"], {
    cwd: `${root}/llm`,
    windowsHide: true,
    stdio: "pipe",
    env: { ...process.env, PYTHONUNBUFFERED: "1", PYTHONUTF8: "1" },
  });
  const worker: GateWorker = { child, buffer: "", job: null, retired: false };
  workers.add(worker);
  child.stderr.on("data", () => {
    /* Never expose model content or interpreter diagnostics. */
  });
  child.on("error", () =>
    fail(
      worker,
      new LlmGateError(
        "unavailable",
        "LLM gate unavailable; install the locked Python environment",
      ),
    ),
  );
  child.on("exit", () => fail(worker, new LlmGateError("unavailable", "LLM gate stopped")));
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (data: string) => {
    if (worker.retired) return;
    worker.buffer += data;
    if (Buffer.byteLength(worker.buffer) > 2_000_000)
      return fail(worker, new LlmGateError("protocol", "Oversized gate reply"));
    let end: number;
    while ((end = worker.buffer.indexOf("\n")) >= 0) {
      const line = worker.buffer.slice(0, end);
      worker.buffer = worker.buffer.slice(end + 1);
      try {
        const parsed: unknown = JSON.parse(line);
        const job = worker.job;
        // Answer text on its way to the person. The Result still follows.
        const frame = stream_frameSchema.safeParse(parsed);
        if (frame.success) {
          if (!job || frame.data.id !== job.id) throw new Error("unexpected frame");
          if (frame.data.delta) {
            job.shown = true;
            job.onDelta?.(frame.data.delta);
          }
          if (frame.data.reset) {
            job.shown = false;
            job.onReset?.();
          }
          continue;
        }
        const reply = envelope.parse(parsed);
        if (!job || reply.id !== job.id) throw new Error("unexpected reply");
        job.onStats?.(reply.stats);
        worker.job = null;
        if (job.ticket) scheduler.finish(job.ticket);
        settle(job, (j) =>
          reply.ok
            ? j.resolve(reply.output)
            : j.reject(
                new LlmGateError(reply.code ?? "protocol", reply.message ?? "Generation failed"),
              ),
        );
        rest(worker);
        pump();
      } catch {
        fail(worker, new LlmGateError("protocol", "Invalid gate reply"));
        return;
      }
    }
  });
  return worker;
}

function idleWorker(): GateWorker | undefined {
  for (const worker of workers) if (!worker.job && !worker.retired) return worker;
  return undefined;
}

function dispatch(job: Job): void {
  const worker = idleWorker() ?? spawnWorker();
  clearTimeout(worker.idle);
  clearTimeout(job.timer);
  holdProcess(worker.child, true);
  worker.job = job;
  job.worker = worker;
  job.timer = setTimeout(
    () => fail(worker, new LlmGateError("timeout", "LLM gate deadline exceeded")),
    RUN_DEADLINE_MS,
  );
  worker.child.stdin.write(job.line, (error) => {
    if (error) fail(worker, new LlmGateError("unavailable", "LLM gate stopped"));
  });
  // A person may arrive while this runs. Have a worker imported and waiting, so
  // preempting costs the background job its progress and costs the person nothing.
  if (job.ticket?.priority === "background" && !idleWorker()) rest(spawnWorker());
}

/** Stop a background generation so a person can have its slot; it runs again later. */
function preempt(ticket: Ticket<Job>): void {
  const job = ticket.payload;
  const worker = job.worker;
  counters.preemptions++;
  clearTimeout(job.timer);
  job.worker = undefined;
  if (worker) {
    worker.job = null;
    retire(worker);
  }
  if (job.shown) {
    job.shown = false;
    job.onReset?.();
  }
  scheduler.requeue(ticket);
  job.timer = setTimeout(() => expire(job), queueWaitMs(ticket.priority));
}

/** Withdraw a request, queued or running, and tell its caller why. */
function cancel(job: Job, error: LlmGateError): void {
  if (!job.ticket) return;
  if (!scheduler.drop(job.ticket)) {
    if (!scheduler.isRunning(job.ticket)) return;
    scheduler.finish(job.ticket);
    const worker = job.worker;
    if (worker) {
      worker.job = null;
      retire(worker);
    }
  }
  settle(job, (j) => j.reject(error));
  pump();
}

function expire(job: Job): void {
  counters.busy++;
  cancel(job, new LlmGateError("busy", "The model is busy; try again in a moment"));
}

/**
 * Whether background work may start. "asking" means the last reading is too old to
 * act on: the runtime is being asked again, and the answer pumps the queue itself.
 */
function backgroundAdmitted(): "yes" | "no" | "asking" {
  const { admission, stale } = backgroundAdmission();
  if (!stale) return admission.admitted ? "yes" : "no";
  if (!backgroundTarget) return "yes";
  void refresh(backgroundTarget).then(pump);
  return "asking";
}

/** Start whatever may start now. Safe to call at any time, from anywhere. */
function pump(): void {
  clearTimeout(recheck);
  recheck = undefined;
  let admitted: ReturnType<typeof backgroundAdmitted> = "yes";
  for (;;) {
    const waiting = scheduler.queued();
    admitted = waiting.background > 0 && waiting.interactive === 0 ? backgroundAdmitted() : "yes";
    const decision = scheduler.next(gateLimits(), admitted === "yes");
    if (!decision) break;
    if ("preempt" in decision) preempt(decision.preempt);
    else dispatch(decision.run.payload);
  }
  // Deferred by the runtime's load: nothing here will change that, so look again.
  if (admitted === "no" && scheduler.queued().background) {
    counters.deferred++;
    recheck = setTimeout(pump, 1000);
    recheck.unref();
  }
}

export function stopGate(reason = new LlmGateError("unavailable", "LLM gate stopped")): void {
  clearTimeout(recheck);
  recheck = undefined;
  for (const worker of [...workers]) {
    worker.job = null;
    retire(worker);
  }
  for (const ticket of scheduler.drain()) settle(ticket.payload, (job) => job.reject(reason));
}

/** Start a worker before the first request needs it. */
export function warmGate(): void {
  try {
    if (!workers.size) rest(spawnWorker());
  } catch {
    /* the first real request reports what is wrong */
  }
}

/** What the gate is doing right now, for the health route and the benchmarks. */
export function gateSnapshot() {
  const limits = gateLimits();
  return {
    concurrency: limits.concurrency,
    backgroundSlots: limits.backgroundSlots,
    workers: workers.size,
    running: scheduler.running(),
    queued: scheduler.queued(),
    preemptions: counters.preemptions,
    busyRejections: counters.busy,
    backgroundDeferrals: counters.deferred,
    runtimeLoad: lastLoad(),
  };
}

export async function generateTyped<T extends Task>(opts: {
  task: T;
  messages: { role: "system" | "user" | "assistant"; content: string }[];
  context?: ValidationContext;
  model?: string;
  baseUrl?: string;
  signal?: AbortSignal;
  /**
   * Who is waiting. Interactive (the default) is a person on a chat turn and goes
   * first; background is work that can wait and may be stopped and rerun to let a
   * person through.
   */
  priority?: Priority;
  /** How the generation went, success or not. Telemetry: must not throw. */
  onStats?: (stats: LlmStats) => void;
  /**
   * Answer text as it generates, before validation: for display only. The promise
   * resolving is what says the whole answer passed. See onReset.
   */
  onDelta?: (text: string) => void;
  /** The gate rejected what onDelta has sent so far and is trying again. */
  onReset?: () => void;
}): Promise<Output<T>> {
  opts.signal?.throwIfAborted();
  const id = randomUUID();
  const line =
    JSON.stringify(
      requestSchema.parse({
        id,
        version: CONTRACT_VERSION,
        task: opts.task,
        messages: opts.messages,
        context: opts.context ?? {},
        model: opts.model,
        base_url: opts.baseUrl,
        ...(opts.onDelta && { stream_answer: true }),
      }),
    ) + "\n";
  if (Buffer.byteLength(line) > 1_000_000)
    throw new LlmGateError("input", "LLM input exceeds byte limit");
  const priority = opts.priority ?? "interactive";
  const output = await new Promise<unknown>((resolve, reject) => {
    const abort = () => cancel(job, new LlmGateError("cancelled", "LLM request cancelled"));
    const job: Job = {
      id,
      line,
      resolve,
      reject,
      onStats: opts.onStats,
      onDelta: opts.onDelta,
      onReset: opts.onReset,
      release: () => opts.signal?.removeEventListener("abort", abort),
      shown: false,
    };
    const ticket = scheduler.enqueue(priority, job, gateLimits());
    if (!ticket) {
      counters.busy++;
      return reject(new LlmGateError("busy", "LLM gate queue is full"));
    }
    job.ticket = ticket;
    opts.signal?.addEventListener("abort", abort, { once: true });
    job.timer = setTimeout(() => expire(job), queueWaitMs(priority));
    if (priority === "background" && opts.baseUrl && opts.model)
      backgroundTarget = { baseUrl: opts.baseUrl, model: opts.model };
    pump();
  });
  return outputSchemas[opts.task].parse(output) as Output<T>;
}
