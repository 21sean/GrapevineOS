/**
 * Loops that can stop, and a shutdown that drains.
 *
 * Every background loop in the server (the inbox poll, push, discovery,
 * retention, the auto-judge) is a startLoop() call: one name, one enable
 * flag, one interval, an optional immediate pass, a reentrancy guard so a
 * slow pass never overlaps the next tick, and a registered stop. Before this
 * each loop hand-rolled the same five steps, only one of them called unref,
 * and none of them could be stopped.
 *
 * On SIGTERM or SIGINT the order is: stop the loops, stop accepting new
 * connections, abort in-flight chat streams (each sends a notice so the tab
 * can retry), run the registered hooks (drain the guardrail telemetry queue,
 * flush Langfuse so no span is lost, close the FastMCP listener, unsubscribe
 * realtime), then close the server. The whole thing is capped: a hook that
 * hangs does not keep a dying process alive past the cap.
 */
import type { Server } from "node:http";
import { logger } from "./log.js";

const log = logger("lifecycle");

interface Loop {
  name: string;
  timer: ReturnType<typeof setInterval>;
}

const loops: Loop[] = [];
const hooks: { name: string; run: () => Promise<void> | void }[] = [];
const chats = new Set<() => void>();
let stopping = false;

/** True once shutdown has begun; loops skip their pass and /readyz says no. */
export function shuttingDown(): boolean {
  return stopping;
}

export interface LoopOptions {
  name: string;
  /** False starts nothing and logs why. */
  enabled: boolean;
  /** Why it is off, for the log line. */
  disabledReason?: string;
  intervalMs: number;
  /** Also run one pass right away. */
  immediate?: boolean;
  run: () => Promise<void>;
}

export function startLoop(opts: LoopOptions): void {
  if (!opts.enabled) {
    log.info(`${opts.name}: off${opts.disabledReason ? ` (${opts.disabledReason})` : ""}`);
    return;
  }
  let busy = false;
  const tick = async () => {
    // A slow pass must not overlap the next tick, and nothing starts once
    // shutdown has begun.
    if (busy || stopping) return;
    busy = true;
    try {
      await opts.run();
    } catch (err) {
      log.warn({ err: String(err).slice(0, 200) }, `${opts.name}: pass failed`);
    } finally {
      busy = false;
    }
  };
  if (opts.immediate) void tick();
  const timer = setInterval(() => void tick(), opts.intervalMs);
  // A loop must never be the reason the process stays alive.
  timer.unref?.();
  loops.push({ name: opts.name, timer });
}

/** Register work to do at shutdown, after the loops stop. Runs in registration order. */
export function onShutdown(name: string, run: () => Promise<void> | void): void {
  hooks.push({ name, run });
}

/**
 * Track an in-flight chat stream. The callback runs at shutdown, before the
 * hooks, and should tell the client and abort the run. Returns the untrack
 * function to call when the stream ends on its own.
 */
export function trackChat(abort: () => void): () => void {
  chats.add(abort);
  return () => chats.delete(abort);
}

/** Wire SIGTERM and SIGINT to an orderly, time-capped shutdown. */
export function installShutdown(server: Server, opts: { timeoutMs?: number } = {}): void {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info(
      `${signal}: shutting down (${loops.length} loops, ${chats.size} chat streams, ${hooks.length} hooks)`,
    );
    const cap = setTimeout(() => {
      log.warn(`shutdown exceeded ${timeoutMs}ms, exiting anyway`);
      process.exit(1);
    }, timeoutMs);
    cap.unref();

    for (const loop of loops) clearInterval(loop.timer);
    // Stop accepting; what is in flight keeps being served until it ends.
    server.close();
    for (const abort of [...chats]) {
      try {
        abort();
      } catch {
        /* the stream is already gone */
      }
    }
    for (const hook of hooks) {
      try {
        await hook.run();
      } catch (err) {
        log.warn({ err: String(err).slice(0, 200) }, `${hook.name}: shutdown hook failed`);
      }
    }
    server.closeAllConnections?.();
    clearTimeout(cap);
    log.info("stopped");
    process.exit(0);
  };
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => void shutdown(signal));
  }
}
