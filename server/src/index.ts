import "dotenv/config";
import express from "express";
import { Readable } from "node:stream";
import { auth } from "./auth.js";
import { store } from "./store.js";
import { listInstalled, ollamaBase } from "./ollama.js";
import { catalog, logo } from "./catalog.js";
import { eta, geocode } from "./mapbox.js";
import { extractEvents, rateEvent } from "./ingest.js";
import { startKvPoll } from "./kvpoll.js";
import type { CityEvent } from "./types.js";

const app = express();
app.use(express.json({ limit: "2mb" }));

// ---------- auth (Google sign-in, sessions, /api/me) ----------

app.use(auth);

// ---------- events ----------

app.get("/api/events", (_req, res) => {
  res.json(store.events());
});

app.post("/api/events/:id/rate", async (req, res) => {
  const event = store.events().find((e) => e.id === req.params.id);
  if (!event) return res.status(404).json({ error: "unknown event" });
  try {
    const r = await rateEvent(event);
    const updated = store.updateEvent(event.id, {
      rating: r.rating,
      ratingRationale: r.rationale,
      promoted: r.promoted,
    });
    res.json(updated);
  } catch (err) {
    res.status(502).json({ error: String(err) });
  }
});

// ---------- settings & sources ----------

app.get("/api/settings", (_req, res) => res.json(store.settings()));

app.put("/api/settings", (req, res) => {
  const { city, center, tz, model, ollamaUrl } = req.body ?? {};
  res.json(
    store.saveSettings({
      ...(city !== undefined && { city }),
      ...(center !== undefined && { center }),
      ...(tz !== undefined && { tz }),
      ...(model !== undefined && { model }),
      ...(ollamaUrl !== undefined && { ollamaUrl }),
    }),
  );
});

app.get("/api/sources", (_req, res) => res.json(store.sources()));

// ---------- mapbox (secret token stays here) ----------

app.get("/api/eta", async (req, res) => {
  const parse = (s: unknown): [number, number] | null => {
    const parts = String(s ?? "").split(",").map(Number);
    return parts.length === 2 && parts.every(Number.isFinite)
      ? [parts[0], parts[1]]
      : null;
  };
  const from = parse(req.query.from) ?? store.settings().center;
  const to = parse(req.query.to);
  if (!to) return res.status(400).json({ error: "to=lng,lat required" });
  try {
    res.json((await eta(from, to)) ?? { minutes: null, km: null });
  } catch (err) {
    res.status(502).json({ error: String(err) });
  }
});

app.get("/api/geocode", async (req, res) => {
  const q = String(req.query.q ?? "");
  if (!q) return res.status(400).json({ error: "q required" });
  try {
    res.json(await geocode(q, store.settings().center));
  } catch (err) {
    res.status(502).json({ error: String(err) });
  }
});

// ---------- ollama ----------

app.get("/api/ollama/health", async (_req, res) => {
  try {
    const r = await fetch(`${ollamaBase()}/api/version`, {
      signal: AbortSignal.timeout(3000),
    });
    const version = r.ok ? ((await r.json()) as { version?: string }).version : null;
    res.json({ ok: r.ok, url: ollamaBase(), version });
  } catch {
    res.json({ ok: false, url: ollamaBase(), version: null });
  }
});

app.get("/api/ollama/models", async (_req, res) => {
  try {
    res.json(await listInstalled());
  } catch (err) {
    res.status(502).json({ error: String(err) });
  }
});

/** Streams Ollama's NDJSON pull progress straight through to the client. */
app.post("/api/ollama/pull", async (req, res) => {
  const model = String(req.body?.model ?? "");
  if (!model) return res.status(400).json({ error: "model required" });
  try {
    const upstream = await fetch(`${ollamaBase()}/api/pull`, {
      method: "POST",
      body: JSON.stringify({ model, stream: true }),
    });
    if (!upstream.ok || !upstream.body) {
      return res.status(502).json({ error: await upstream.text() });
    }
    res.setHeader("Content-Type", "application/x-ndjson");
    Readable.fromWeb(upstream.body as any).pipe(res);
  } catch (err) {
    res.status(502).json({ error: String(err) });
  }
});

// ---------- model catalog (models.dev) ----------

app.get("/api/catalog", async (_req, res) => {
  res.json(await catalog());
});

app.get("/api/logo/:id", async (req, res) => {
  res.setHeader("Content-Type", "image/svg+xml");
  res.setHeader("Cache-Control", "public, max-age=86400");
  res.send(await logo(req.params.id));
});

// ---------- ingestion ----------

const eventSnapshot = (events: CityEvent[]) =>
  events.map((e) => ({ id: e.id, title: e.title, start: e.start }));

/** Newest-first log of every email/paste that went through the pipeline. */
app.get("/api/ingest/history", (_req, res) => {
  res.json(store.ingests());
});

/** Extract events from pasted/forwarded email text. dryRun previews only. */
app.post("/api/ingest/email", async (req, res) => {
  const { text, source = "manual", dryRun = false } = req.body ?? {};
  if (!text) return res.status(400).json({ error: "text required" });
  try {
    const events = await extractEvents({ text, source });
    if (dryRun) return res.json({ events, added: 0 });
    const added = store.addEvents(events);
    store.logIngest({
      source,
      kind: "manual",
      extracted: events.length,
      added: added.length,
      events: eventSnapshot(added),
    });
    res.json({ events, added: added.length });
  } catch (err) {
    res.status(502).json({ error: String(err) });
  }
});

/** Commit previously previewed events. */
app.post("/api/ingest/commit", (req, res) => {
  const events: CityEvent[] = req.body?.events ?? [];
  if (!Array.isArray(events) || !events.length) {
    return res.status(400).json({ error: "events[] required" });
  }
  const added = store.addEvents(events);
  store.logIngest({
    source: events[0]?.source ?? "manual",
    kind: "manual",
    extracted: events.length,
    added: added.length,
    events: eventSnapshot(added),
  });
  res.json({ added: added.length });
});

/**
 * Endpoint the Cloudflare Email Worker posts to (when you expose this
 * server via a tunnel or deploy it). Guarded by a shared key.
 */
app.post("/api/ingest/inbound", async (req, res) => {
  if (req.get("X-Ingest-Key") !== process.env.INGEST_SHARED_KEY) {
    return res.status(401).json({ error: "bad ingest key" });
  }
  const { to = "", subject = "", text = "" } = req.body ?? {};
  // catch-all addressing: dostuff@… → source "dostuff"
  const source = String(to).split("@")[0] || "inbound";
  try {
    const events = await extractEvents({ text: `Subject: ${subject}\n\n${text}`, source });
    const added = store.addEvents(events);
    store.logIngest({
      source,
      kind: "email",
      subject: String(subject) || undefined,
      extracted: events.length,
      added: added.length,
      events: eventSnapshot(added),
    });
    res.json({ extracted: events.length, added: added.length });
  } catch (err) {
    res.status(502).json({ error: String(err) });
  }
});

const port = Number(process.env.PORT ?? 8787);
app.listen(port, () => {
  console.log(`[grapevine] api listening on http://localhost:${port}`);
  startKvPoll();
});
