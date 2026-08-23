import "dotenv/config";
import express from "express";
import { Readable } from "node:stream";
import { agent } from "./agent/index.js";
import { invalidateGuardConfig, warmupGuardrails } from "./agent/guardrails.js";
import { auth, sessionUser } from "./auth.js";
import { calendar } from "./calendar.js";
import {
  clampCadence,
  runDiscovery,
  runSavedSearch,
  startDiscoveryScheduler,
  validQuery,
  wantsCommit,
} from "./discovery.js";
import { backfillImages } from "./images.js";
import { mcp, mcpAuthMode, startMcpServer } from "./mcp.js";
import { evals } from "./evals/index.js";
import { guardrails } from "./guardrails/index.js";
import { detectProviders } from "./providers.js";
import { push, startPushScheduler } from "./push.js";
import { startRetentionSweep } from "./retention.js";
import { store } from "./store.js";
import { listInstalled, ollamaBase } from "./ollama.js";
import { catalog, logo } from "./catalog.js";
import { systemInfo } from "./system.js";
import { eta, isochrone } from "./mapbox.js";
import { PlacesQuotaError, PlacesScopeError, venueDetails } from "./places.js";
import { extractEvents, rateEvent } from "./ingest.js";
import { kickInbox, listInbox, reprocessInbox, startInboxPoll } from "./inbox.js";
import { commitIngest } from "./pipeline.js";
import { LLM_PROVIDERS, REACTIONS, type CityEvent, type Reaction } from "./types.js";

const app = express();
// Behind a tunnel/reverse proxy (the MCP connector path), X-Forwarded-Proto
// must win so OAuth discovery URLs come out https.
app.set("trust proxy", true);
// /mcp is reverse-proxied to the FastMCP listener verbatim, so its JSON-RPC
// body must stay an unread stream — everything else gets the usual parser.
const parseJson = express.json({ limit: "2mb" });
app.use((req, res, next) => (req.path === "/mcp" ? next() : parseJson(req, res, next)));

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

// ---------- evals (the offline quality gate behind Admin -> Evals) ----------

app.use(evals);

// ---------- guardrail observability (Admin -> Guardrails) ----------

app.use(guardrails);

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

app.get("/api/settings", async (_req, res) => {
  try {
    res.json(await store.settings());
  } catch (err) {
    res.status(502).json({ error: String(err) });
  }
});

app.put("/api/settings", async (req, res) => {
  const { city, center, tz, model, ollamaUrl, chatProvider, extractProvider } =
    req.body ?? {};
  if (chatProvider !== undefined && !LLM_PROVIDERS.includes(chatProvider)) {
    return res.status(400).json({ error: "unknown chatProvider" });
  }
  if (extractProvider !== undefined && !LLM_PROVIDERS.includes(extractProvider)) {
    return res.status(400).json({ error: "unknown extractProvider" });
  }
  try {
    const saved = await store.saveSettings({
      ...(city !== undefined && { city }),
      ...(center !== undefined && { center }),
      ...(tz !== undefined && { tz }),
      ...(model !== undefined && { model }),
      ...(ollamaUrl !== undefined && { ollamaUrl }),
      ...(chatProvider !== undefined && { chatProvider }),
      ...(extractProvider !== undefined && { extractProvider }),
    });
    // The rails cache mode/threshold for a few seconds; a save from any
    // settings surface has to drop that cache or the retune appears to have
    // been ignored. (Admin -> Guardrails does this for its own writes too.)
    invalidateGuardConfig();
    res.json(saved);
  } catch (err) {
    res.status(502).json({ error: String(err) });
  }
});

app.get("/api/sources", async (_req, res) => {
  try {
    res.json(await store.sources());
  } catch (err) {
    res.status(502).json({ error: String(err) });
  }
});

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
  const url = `${base.replace(/\/$/, "")}/mcp`;
  res.json({
    url,
    transport: "http",
    // "oauth": clients sign in via the Supabase-backed consent flow (or send
    // AGENT_API_KEY as a header for headless scripts). "open": MCP_OPEN=1.
    auth: mcpAuthMode(),
    connectorUrl: url,
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

/**
 * "Near me" drive-time contour. The web app filters events to the polygons —
 * the point-in-polygon test happens client-side so one cached contour serves
 * the whole list.
 */
app.get("/api/isochrone", async (req, res) => {
  const parse = (s: unknown): [number, number] | null => {
    const parts = String(s ?? "").split(",").map(Number);
    return parts.length === 2 && parts.every(Number.isFinite)
      ? [parts[0], parts[1]]
      : null;
  };
  const center = parse(req.query.center) ?? (await store.settings()).center;
  const minutes = Number(req.query.minutes);
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > 60) {
    return res.status(400).json({ error: "minutes must be 1-60" });
  }
  try {
    res.json((await isochrone(center, minutes)) ?? { polygons: [] });
  } catch (err) {
    res.status(502).json({ error: String(err).slice(0, 200) });
  }
});

/**
 * Venue intelligence for one event's location (Mapbox Places, public preview):
 * hours, photos, accessibility, and how busy the place usually is.
 *
 * Keyed off an event id rather than a free-text venue on purpose — an open
 * ?venue= proxy would let anyone spend our 1,000-record monthly preview quota
 * on arbitrary lookups. This way only venues already in the map can be asked
 * about, and the answer comes from the Postgres venue cache when it's warm
 * (see places.ts).
 */
app.get("/api/events/:id/venue", async (req, res) => {
  const event = await store.eventById(req.params.id);
  if (!event) return res.status(404).json({ error: "unknown event" });
  try {
    res.json({ venue: await venueDetails(event.venue, [event.lng, event.lat]) });
  } catch (err) {
    // A missing scope or an exhausted quota is a configuration answer, not a
    // 502: the panel just hides the venue card, and the message says why.
    if (err instanceof PlacesScopeError || err instanceof PlacesQuotaError) {
      return res.status(200).json({ venue: null, unavailable: String(err.message) });
    }
    res.status(502).json({ error: String(err).slice(0, 200) });
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

/** Local hardware (VRAM/RAM) so the catalog can say what fits. */
app.get("/api/system", async (_req, res) => {
  res.json(await systemInfo());
});

app.get("/api/logo/:id", async (req, res) => {
  res.setHeader("Content-Type", "image/svg+xml");
  res.setHeader("Cache-Control", "public, max-age=86400");
  res.send(await logo(req.params.id));
});

// ---------- ingestion ----------

/** Clear shared/generic banners, then scrape og:images for events without art. */
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
  const { text, source = "manual" } = req.body ?? {};
  const dry = req.body?.dryRun === true || req.body?.dry_run === true;
  if (!text) return res.status(400).json({ error: "text required" });
  try {
    // Pasted text is a manual entry — the stored events and the ingest log
    // agree on provenance (both "manual").
    const events = await extractEvents({ text, source, sourceKind: "manual" });
    if (dry) return res.json({ events, added: 0 });
    const { added } = await commitIngest({ events, source, kind: "manual" });
    res.json({ events, added: added.length });
  } catch (err) {
    res.status(502).json({ error: String(err) });
  }
});

/** Commit previously previewed events (email pastes and discovery dry runs). */
app.post("/api/ingest/commit", async (req, res) => {
  const events: CityEvent[] = req.body?.events ?? [];
  if (!Array.isArray(events) || !events.length) {
    return res.status(400).json({ error: "events[] required" });
  }
  try {
    const { added } = await commitIngest({
      events,
      source: events[0]?.source ?? "manual",
      kind: events[0]?.sourceKind === "search" ? "search" : "manual",
    });
    res.json({ added: added.length });
  } catch (err) {
    res.status(502).json({ error: String(err) });
  }
});

/**
 * Kick endpoint the Cloudflare Email Worker pings (when you expose this server
 * via a tunnel or deploy it) right after it inserts the email into raw_emails.
 * The worker's insert is the durable ledger; this just wakes the processor so
 * extraction runs on arrival instead of on a timer. Fire-and-forget: the
 * worker isn't blocked on the local model, and the row's processed_at/retry
 * state owns durability. Guarded by a shared key.
 */
app.post("/api/ingest/inbound", (req, res) => {
  if (req.get("X-Ingest-Key") !== process.env.INGEST_SHARED_KEY) {
    return res.status(401).json({ error: "bad ingest key" });
  }
  kickInbox();
  res.json({ ok: true, queued: true });
});

// ---------- web discovery (AI web search → verified events, on a schedule) ----------

/**
 * Run one web discovery search now. Dry run by default, same as the external
 * API and MCP surfaces — committing requires an explicit dry_run:false
 * (dryRun:false also accepted), so an omitted flag can never write.
 */
app.post("/api/discovery/run", async (req, res) => {
  const query = validQuery(req.body?.query);
  if (!query) return res.status(400).json({ error: "query must be 3-200 chars" });
  try {
    res.json(await runDiscovery({ query, commit: wantsCommit(req.body) }));
  } catch (err) {
    res.status(502).json({ error: String(err).slice(0, 300) });
  }
});

app.get("/api/discovery/searches", async (_req, res) => {
  try {
    res.json({ searches: await store.discoverySearches() });
  } catch (err) {
    res.status(502).json({ error: String(err).slice(0, 300) });
  }
});

/** Save (or update, keyed on the query) a scheduled search. */
app.post("/api/discovery/searches", async (req, res) => {
  const query = validQuery(req.body?.query);
  if (!query) return res.status(400).json({ error: "query must be 3-200 chars" });
  try {
    res.json(await store.addDiscoverySearch(query, clampCadence(req.body?.cadenceHours)));
  } catch (err) {
    res.status(502).json({ error: String(err).slice(0, 300) });
  }
});

app.patch("/api/discovery/searches/:id", async (req, res) => {
  const patch: { active?: boolean; cadenceHours?: number } = {};
  if (req.body?.active !== undefined) patch.active = Boolean(req.body.active);
  if (req.body?.cadenceHours !== undefined)
    patch.cadenceHours = clampCadence(req.body.cadenceHours);
  if (!Object.keys(patch).length) {
    return res.status(400).json({ error: "nothing to update (active, cadenceHours)" });
  }
  try {
    const updated = await store.updateDiscoverySearch(req.params.id, patch);
    if (!updated) return res.status(404).json({ error: "unknown search" });
    res.json(updated);
  } catch (err) {
    res.status(502).json({ error: String(err).slice(0, 300) });
  }
});

app.delete("/api/discovery/searches/:id", async (req, res) => {
  try {
    const deleted = await store.deleteDiscoverySearch(req.params.id);
    if (!deleted) return res.status(404).json({ error: "unknown search" });
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: String(err).slice(0, 300) });
  }
});

/** Run one saved search immediately (also stamps last_run/status). */
app.post("/api/discovery/searches/:id/run", async (req, res) => {
  try {
    const search = await store.discoverySearchById(req.params.id);
    if (!search) return res.status(404).json({ error: "unknown search" });
    res.json(await runSavedSearch(search));
  } catch (err) {
    res.status(502).json({ error: String(err).slice(0, 300) });
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
  startDiscoveryScheduler();
  startRetentionSweep();
  warmupGuardrails();
  startMcpServer().catch((err) =>
    console.error("[grapevine] mcp failed to start:", String(err).slice(0, 300)),
  );
});
