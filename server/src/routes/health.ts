/**
 * Liveness, readiness and identity, the three questions a process supervisor
 * asks. /healthz answers "is the process up", /readyz answers "can it serve
 * a chat turn" with the reasons, /version says what it is.
 */
import { Router } from "express";
import { classifierReady, guardConfig } from "../agent/guardrails.js";
import { db } from "../db.js";
import { shuttingDown } from "../lifecycle.js";
import { llmBase, llmRuntime, runtimeVersion } from "../llm/runtime.js";
import { store } from "../store.js";
import { VERSION } from "../version.js";

export const health = Router();

const startedAt = Date.now();

type Probe<T> = { ok: true; ms: number; value: T } | { ok: false; ms: number; error: string };

/** Run a probe under a deadline. A slow dependency is reported, never waited on. */
async function probe<T>(fn: () => Promise<T>, ms: number): Promise<Probe<T>> {
  const t0 = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer in ${ms}ms`)), ms);
  });
  try {
    const value = await Promise.race([fn(), deadline]);
    return { ok: true, ms: Date.now() - t0, value };
  } catch (err) {
    return {
      ok: false,
      ms: Date.now() - t0,
      error: String((err as Error)?.message ?? err).slice(0, 200),
    };
  } finally {
    clearTimeout(timer);
  }
}

health.get("/healthz", (_req, res) => {
  res.status(shuttingDown() ? 503 : 200).json({
    ok: !shuttingDown(),
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
  });
});

/**
 * Ready means the database and the checkpointer answer: without them a chat
 * turn cannot read settings or remember anything. The classifier is reported
 * but does not gate readiness (the rails fail open by design, and the panel
 * says so), and the local runtime is informational: the map and the rest of the
 * app work without it, and chat says so itself when it is down.
 */
health.get("/readyz", async (_req, res) => {
  const [database, checkpointer, local, guard] = await Promise.all([
    probe(async () => {
      const s = await store.settings();
      return { city: s.city };
    }, 3_000),
    probe(async () => {
      await db.from("chat_checkpoints").select("thread_id").limit(1).throwOnError();
      return "answering";
    }, 3_000),
    probe(async () => {
      const version = await runtimeVersion(await llmBase(), 2_000);
      if (version === null) throw new Error("no answer");
      return version;
    }, 2_500),
    guardConfig(),
  ]);
  const classifier = guard.mode === "off" ? "off" : classifierReady() ? "ready" : "failing-open";
  const ready = database.ok && checkpointer.ok && !shuttingDown();
  res.status(ready ? 200 : 503).json({
    ready,
    database,
    checkpointer,
    classifier: { state: classifier, mode: guard.mode, threshold: guard.threshold },
    [llmRuntime()]: { ...local, informational: true },
  });
});

health.get("/version", (_req, res) => {
  res.json(VERSION);
});
