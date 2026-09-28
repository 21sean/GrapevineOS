/**
 * Admin, Models: the local Ollama (health, installed models, pulls), the
 * models.dev catalog, and the hardware the catalog is sized against. All
 * admin-only; a model pull writes gigabytes to the server's disk.
 */
import { Router } from "express";
import { Readable } from "node:stream";
import { requireAdmin } from "../auth.js";
import { catalog, logo } from "../catalog.js";
import { listInstalled, ollamaBase } from "../ollama.js";
import { systemInfo } from "../system.js";

export const ollama = Router();

ollama.get("/api/ollama/health", requireAdmin, async (_req, res) => {
  const base = await ollamaBase().catch(() => "http://localhost:11434");
  try {
    const r = await fetch(`${base}/api/version`, { signal: AbortSignal.timeout(3000) });
    const version = r.ok ? ((await r.json()) as { version?: string }).version : null;
    res.json({ ok: r.ok, url: base, version });
  } catch {
    // Down is an answer here, not an error.
    res.json({ ok: false, url: base, version: null });
  }
});

ollama.get("/api/ollama/models", requireAdmin, async (_req, res) => {
  res.json(await listInstalled());
});

/** Streams Ollama's NDJSON pull progress straight through to the client. */
ollama.post("/api/ollama/pull", requireAdmin, async (req, res) => {
  const model = String(req.body?.model ?? "");
  if (!model) return res.status(400).json({ error: "model required" });
  const base = await ollamaBase().catch(() => "http://localhost:11434");
  const upstream = await fetch(`${base}/api/pull`, {
    method: "POST",
    body: JSON.stringify({ model, stream: true }),
  }).catch(() => null);
  if (!upstream) return res.status(502).json({ error: `Ollama is not reachable at ${base}` });
  if (!upstream.ok || !upstream.body) {
    return res.status(502).json({ error: await upstream.text() });
  }
  res.setHeader("Content-Type", "application/x-ndjson");
  Readable.fromWeb(upstream.body as any).pipe(res);
});

// ---------- model catalog (models.dev) ----------

ollama.get("/api/catalog", requireAdmin, async (_req, res) => {
  res.json(await catalog());
});

/** Local hardware (VRAM/RAM) so the catalog can say what fits. */
ollama.get("/api/system", requireAdmin, async (_req, res) => {
  res.json(await systemInfo());
});

/** Provider logos proxied from models.dev; public, cacheable, no secrets. */
ollama.get("/api/logo/:id", async (req, res) => {
  res.setHeader("Content-Type", "image/svg+xml");
  res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "public, max-age=86400");
  res.send(await logo(String(req.params.id)));
});
