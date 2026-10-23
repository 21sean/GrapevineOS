import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  CONTRACT_VERSION,
  outputSchemas,
  type Output,
  type Task,
  type ValidationContext,
} from "./generated.js";

export class LlmGateError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "LlmGateError";
  }
}
const envelope = z
  .object({
    id: z.string(),
    version: z.literal(CONTRACT_VERSION),
    ok: z.boolean(),
    output: z.unknown().optional(),
    code: z.string().optional(),
    message: z.string().optional(),
    stats: z
      .object({
        attempts: z.number().int().nonnegative(),
        validation_failures: z.number().int().nonnegative(),
        first_pass: z.boolean(),
        validation_ms: z.number().nonnegative(),
        total_ms: z.number().nonnegative(),
        repair_ms: z.number().nonnegative(),
      })
      .strict(),
  })
  .strict();
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
type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };
let worker: ChildProcessWithoutNullStreams | null = null;
let buffer = "";
const pending = new Map<string, Pending>();
let idle: ReturnType<typeof setTimeout> | undefined;

export function stopGate(reason = new LlmGateError("unavailable", "LLM gate stopped")): void {
  const previous = worker;
  worker = null;
  buffer = "";
  clearTimeout(idle);
  for (const p of pending.values()) p.reject(reason);
  pending.clear();
  previous?.kill();
}
function start(): ChildProcessWithoutNullStreams {
  clearTimeout(idle);
  if (worker) return worker;
  const child = spawn(python, ["-m", "grapevine_llm.worker"], {
    cwd: `${root}/llm`,
    windowsHide: true,
    stdio: "pipe",
    env: { ...process.env, PYTHONUNBUFFERED: "1", PYTHONUTF8: "1" },
  });
  worker = child;
  child.stderr.on("data", () => {
    /* Never expose model content or interpreter diagnostics. */
  });
  child.on("error", () => {
    if (worker === child)
      stopGate(
        new LlmGateError(
          "unavailable",
          "LLM gate unavailable; install the locked Python environment",
        ),
      );
  });
  child.on("exit", () => {
    if (worker === child) stopGate();
  });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (data: string) => {
    if (worker !== child) return;
    buffer += data;
    if (Buffer.byteLength(buffer) > 2_000_000)
      return stopGate(new LlmGateError("protocol", "Oversized gate reply"));
    let end: number;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      try {
        const reply = envelope.parse(JSON.parse(line));
        const p = pending.get(reply.id);
        if (!p) throw new Error("unexpected reply");
        pending.delete(reply.id);
        if (reply.ok) p.resolve(reply.output);
        else
          p.reject(
            new LlmGateError(reply.code ?? "protocol", reply.message ?? "Generation failed"),
          );
        if (!pending.size) idle = setTimeout(() => stopGate(), 1000).unref();
      } catch {
        stopGate(new LlmGateError("protocol", "Invalid gate reply"));
        return;
      }
    }
  });
  return child;
}

export async function generateTyped<T extends Task>(opts: {
  task: T;
  messages: { role: "system" | "user" | "assistant"; content: string }[];
  context?: ValidationContext;
  model?: string;
  baseUrl?: string;
  signal?: AbortSignal;
}): Promise<Output<T>> {
  opts.signal?.throwIfAborted();
  if (pending.size >= 16) throw new LlmGateError("busy", "LLM gate queue is full");
  const id = randomUUID();
  const line =
    JSON.stringify({
      id,
      version: CONTRACT_VERSION,
      task: opts.task,
      messages: opts.messages,
      context: opts.context ?? {},
      model: opts.model,
      base_url: opts.baseUrl,
    }) + "\n";
  if (Buffer.byteLength(line) > 1_000_000)
    throw new LlmGateError("input", "LLM input exceeds byte limit");
  const child = start();
  const output = await new Promise<unknown>((resolve, reject) => {
    const timeout = setTimeout(
      () => stopGate(new LlmGateError("timeout", "LLM gate deadline exceeded")),
      125_000,
    );
    const abort = () => stopGate(new LlmGateError("cancelled", "LLM request cancelled"));
    const clean = () => {
      clearTimeout(timeout);
      opts.signal?.removeEventListener("abort", abort);
    };
    pending.set(id, {
      resolve: (value) => {
        clean();
        resolve(value);
      },
      reject: (error) => {
        clean();
        reject(error);
      },
    });
    opts.signal?.addEventListener("abort", abort, { once: true });
    if (opts.signal?.aborted) return abort();
    child.stdin.write(line, (error) => {
      if (error && worker === child) stopGate();
    });
  });
  return outputSchemas[opts.task].parse(output) as Output<T>;
}
