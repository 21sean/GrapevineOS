import "dotenv/config";
import express from "express";
import { Readable } from "node:stream";
import { agent } from "./agent/index.js";
import { warmupGuardrails } from "./agent/guardrails.js";
import { auth, sessionUser } from "./auth.js";
import { calendar } from "./calendar.js";
import { backfillImages, enrichEventImages } from "./images.js";
import { mcp, mcpKeyRequired } from "./mcp.js";
import { detectProviders } from "./providers.js";
import { push, startPushScheduler } from "./push.js";
import { store } from "./store.js";
import { listInstalled, ollamaBase } from "./ollama.js";
import { catalog, logo } from "./catalog.js";
import { eta, geocode } from "./mapbox.js";
import { extractEvents, rateEvent } from "./ingest.js";
import { listInbox, reprocessInbox, startInboxPoll } from "./inbox.js";
import { LLM_PROVIDERS, REACTIONS, type CityEvent, type Reaction } from "./types.js";

const app = express();
app.use(express.json({ limit: "2mb" }));

// ---------- auth (Google sign-in, sessions, /api/me) ----------

app.use(auth);

// ---------- calendar (saved events, Google sync, ICS feed) ----------

app.use(calendar);

// ---------- agent ("Ask Grapevine" chat + external tools API) ----------

app.use(agent);

// ---------- MCP server (Grapevine tools for Claude & other MCP clients) ----------

app.use(mcp);

// ---------- web push (reminders + weekly digest) ----------

app.use(push);

// ---------- events ----------

app.get("/api/events", async (_req, res) => {
  try {
    res.json(await store.events());
  } catch (err) {
    res.status(502).json({ error: String(err) });
  }
});

app.post("/api/events/:id/rate", async (req, res) => {
  const event = await store.eventById(req.params.id);
  if (!event) return res.status(404).json({ error: "unknown event" });
  try {
    const r = await rateEvent(event);
    const updated = await store.updateEvent(event.id, {
      rating: r.rating,
      ratingRationale: r.rationale,
      promoted: r.promoted,
    });
    res.json(updated);
  } catch (err) {
    res.status(502).json({ error: String(err) });
  }
});

// ---------- reactions (per-user feedback loop) ----------

app.get("/api/reactions", async (req, res) => {
  const user = await sessionUser(req);
  if (!user) return res.status(401).json({ error: "not signed in" });
  try {
    res.json({ reactions: await store.userReactions(user.id) });
  } catch (err) {
    res.status(502).json({ error: String(err) });
  }
});

/** Set or clear (reaction: null) the caller's reaction to an event. */
app.put("/api/events/:id/reaction", async (req, res) => {
  const user = await sessionUser(req);
  if (!user) return res.status(401).json({ error: "not signed in" });
  const reaction = req.body?.reaction ?? null;
  if (reaction !== null && !REACTIONS.includes(reaction)) {
    return res.status(400).json({ error: `reaction must be null or one of: ${REACTIONS.join(", ")}` });
  }
  const event = await store.eventById(req.params.id);
  if (!event) return res.status(404).json({ error: "unknown event" });
  try {
    await store.setReaction(user.id, event.id, reaction as Reaction | null);
    res.json({ ok: true, eventId: event.id, reaction });
  } catch (err) {
    res.status(502).json({ error: String(err) });
  }
});

// ---------- settings & sources ----------

app.get("/api/settings", async (_req, res) => res.json(await store.settings()));

app.put("/api/settings", async (req, res) => {
  const { city, center, tz, model, ollamaUrl, chatProvider, extractProvider } =
    req.body ?? {};
  if (chatProvider !== undefined && !LLM_PROVIDERS.includes(chatProvider)) {
    return res.status(400).json({ error: "unknown chatProvider" });
  }
  if (extractProvider !== undefined && !LLM_PROVIDERS.includes(extractProvider)) {
    return res.status(400).json({ error: "unknown extractProvider" });
  }
  res.json(
    await store.saveSettings({
      ...(city !== undefined && { city }),
      ...(center !== undefined && { center }),
      ...(tz !== undefined && { tz }),
      ...(model !== undefined && { model }),
      ...(ollamaUrl !== undefined && { ollamaUrl }),
      ...(chatProvider !== undefined && { chatProvider }),
      ...(extractProvider !== undefined && { extractProvider }),
    }),
  );
});

app.get("/api/sources", async (_req, res) => res.json(await store.sources()));

// ---------- chat providers (subscription CLIs) + MCP status ----------

app.get("/api/providers", async (req, res) => {
  try {
    const force = req.query.refresh === "1";
    res.json({ providers: await detectProviders(force) });
  } catch (err) {
    res.status(502).json({ error: String(err) });
  }
});

app.get("/api/mcp/info", (_req, res) => {
  // /mcp is served by this express app directly (not proxied through the web
  // origin), so an MCP client connects to the server port. MCP_PUBLIC_URL
  // overrides it when the server sits behind a public reverse proxy.
  const base = process.env.MCP_PUBLIC_URL ?? `http://localhost:${port}`;
  res.json({
    url: `${base.replace(/\/$/, "")}/mcp`,
    transport: "http",
    keyRequired: mcpKeyRequired(),
  });
});

// ---------- mapbox (secret token stays here) ----------

app.get("/api/eta", async (req, res) => {
  const parse = (s: unknown): [number, number] | null => {
    const parts = String(s ?? "").split(",").map(Number);
    return parts.length === 2 && parts.every(Number.isFinite)
      ? [parts[0], parts[1]]
      : null;
  };
  const from = parse(req.query.from) ?? (await store.settings()).center;
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
    res.json(await geocode(q, (await store.settings()).center));
  } catch (err) {
    res.status(502).json({ error: String(err) });
  }
});

// ---------- ollama ----------

app.get("/api/ollama/health", async (_req, res) => {
  const base = await ollamaBase().catch(() => "http://localhost:11434");
  try {
    const r = await fetch(`${base}/api/version`, {
      signal: AbortSignal.timeout(3000),
    });
    const version = r.ok ? ((await r.json()) as { version?: string }).version : null;
    res.json({ ok: r.ok, url: base, version });
  } catch {
    res.json({ ok: false, url: base, version: null });
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
    const upstream = await fetch(`${await ollamaBase()}/api/pull`, {
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

/** Artwork pass runs after the ingest response — decoration, not a gate. */
const enrichLater = (events: CityEvent[]) => {
  if (events.length) void enrichEventImages(events).catch(() => {});
};

/** Scrape og:images for catalog events that never got artwork. */
app.post("/api/ingest/backfill-images", async (_req, res) => {
  try {
    res.json(await backfillImages());
  } catch (err) {
    res.status(502).json({ error: String(err) });
  }
});

/** Newest-first log of every email/paste that went through the pipeline. */
app.get("/api/ingest/history", async (_req, res) => {
  try {
    res.json(await store.ingests());
  } catch (err) {
    res.status(502).json({ error: String(err) });
  }
});

/** Extract events from pasted/forwarded email text. dryRun previews only. */
app.post("/api/ingest/email", async (req, res) => {
  const { text, source = "manual", dryRun = false } = req.body ?? {};
  if (!text) return res.status(400).json({ error: "text required" });
  try {
    const events = await extractEvents({ text, source });
    if (dryRun) return res.json({ events, added: 0 });
    const added = await store.addEvents(events);
    await store.logIngest({
      source,
      kind: "manual",
      extracted: events.length,
      added: added.length,
      events: eventSnapshot(added),
    });
    enrichLater(added);
    res.json({ events, added: added.length });
  } catch (err) {
    res.status(502).json({ error: String(err) });
  }
});

/** Commit previously previewed events. */
app.post("/api/ingest/commit", async (req, res) => {
  const events: CityEvent[] = req.body?.events ?? [];
  if (!Array.isArray(events) || !events.length) {
    return res.status(400).json({ error: "events[] required" });
  }
  try {
    const added = await store.addEvents(events);
    await store.logIngest({
      source: events[0]?.source ?? "manual",
      kind: "manual",
      extracted: events.length,
      added: added.length,
      events: eventSnapshot(added),
    });
    enrichLater(added);
    res.json({ added: added.length });
  } catch (err) {
    res.status(502).json({ error: String(err) });
  }
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
    const added = await store.addEvents(events);
    await store.logIngest({
      source,
      kind: "email",
      subject: String(subject) || undefined,
      extracted: events.length,
      added: added.length,
      events: eventSnapshot(added),
    });
    enrichLater(added);
    res.json({ extracted: events.length, added: added.length });
  } catch (err) {
    res.status(502).json({ error: String(err) });
  }
});

// ---------- inbox (raw emails in Postgres, written by the email worker) ----------

app.get("/api/inbox", async (_req, res) => {
  try {
    res.json(await listInbox());
  } catch (err) {
    res.status(502).json({ error: String(err) });
  }
});

app.post("/api/inbox/reprocess", async (req, res) => {
  const key = String(req.body?.key ?? "");
  if (!key) return res.status(400).json({ error: "key required" });
  try {
    res.json(await reprocessInbox(key));
  } catch (err) {
    res.status(502).json({ error: String(err) });
  }
});

const port = Number(process.env.PORT ?? 8787);
app.listen(port, () => {
  console.log(`[grapevine] api listening on http://localhost:${port}`);
  startInboxPoll();
  startPushScheduler();
  warmupGuardrails();
});
