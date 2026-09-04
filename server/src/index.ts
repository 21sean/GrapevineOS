/**
 * The API server: one Express app assembled from routers that each own one
 * banner below, the background loops that start once it listens, and the
 * shutdown that stops them in order.
 */
import "dotenv/config";
import express from "express";
import { logAdminPosture } from "./admin-gate.js";
import { chat } from "./agent/chat.js";
import { ext } from "./agent/ext.js";
import { warmupGuardrails } from "./agent/guardrails.js";
import { flush as flushGuardrailTelemetry } from "./agent/telemetry.js";
import { auth, requireAdmin } from "./auth.js";
import { calendar } from "./calendar.js";
import { startDiscoveryScheduler } from "./discovery.js";
import { startEvalSweep } from "./evals/auto-judge.js";
import { evals } from "./evals/index.js";
import { guardrails } from "./guardrails/index.js";
import { startInboxPoll, stopInbox } from "./inbox.js";
import { shutdownLangfuse } from "./langfuse.js";
import { installShutdown, onShutdown } from "./lifecycle.js";
import { logger } from "./log.js";
import { mcpAuthMode, startMcpServer, stopMcpServer } from "./mcp.js";
import { mcp } from "./mcp-proxy.js";
import { push, startPushScheduler } from "./push.js";
import { errorHandler, notFound, requestId } from "./request-id.js";
import { startRetentionSweep } from "./retention.js";
import { alerts } from "./routes/alerts.js";
import { capabilities } from "./routes/capabilities.js";
import { discoveryRouter } from "./routes/discovery.js";
import { events } from "./routes/events.js";
import { health } from "./routes/health.js";
import { inbox } from "./routes/inbox.js";
import { ingest } from "./routes/ingest.js";
import { mapbox } from "./routes/mapbox.js";
import { ollama } from "./routes/ollama.js";
import { providers } from "./routes/providers.js";
import { settings } from "./routes/settings.js";
import { watches } from "./routes/watches.js";
import { validateSecrets } from "./secrets.js";
import { VERSION } from "./version.js";

const log = logger("server");

// Before anything listens: an example secret left in place is a
// misconfiguration worth a crash, not a warning scrolled past.
validateSecrets();

const app = express();
// Behind a tunnel/reverse proxy (the MCP connector path), X-Forwarded-Proto
// must win so OAuth discovery URLs come out https.
app.set("trust proxy", true);
app.use(requestId);
// /mcp is reverse-proxied to the FastMCP listener verbatim, so its JSON-RPC
// body must stay an unread stream; everything else gets the usual parser.
const parseJson = express.json({ limit: "2mb" });
app.use((req, res, next) => (req.path === "/mcp" ? next() : parseJson(req, res, next)));

// ---------- liveness, readiness, version ----------
app.use(health);

// ---------- auth (Supabase sign-in, /api/me, the admin gate) ----------
app.use(auth);

// ---------- calendar (saved events, Google sync, ICS feed) ----------
app.use(calendar);

// ---------- agent ("Ask Grapevine" chat, what it can do, the external tools API) ----------
app.use(chat);
app.use(capabilities);
app.use(watches);
app.use(ext);

// ---------- MCP server (Grapevine tools for Claude and other MCP clients) ----------
app.use(mcp);

// ---------- web push (reminders, leave-by alerts, weekly digest) ----------
app.use(push);

// ---------- monitoring (Admin, Monitoring: evals and guardrail telemetry) ----------
app.use(evals);
app.use(guardrails);

// ---------- events, reactions, settings, sources ----------
app.use(events);
app.use(settings);

// ---------- providers, models, mapbox ----------
app.use(providers);
app.use(ollama);
app.use(mapbox);

// ---------- ingestion: pastes, the inbox, web discovery ----------
app.use(ingest);
app.use(inbox);
app.use("/api/discovery", discoveryRouter(requireAdmin));

// ---------- observability alerts (Langfuse webhook receiver) ----------
app.use(alerts);

// ---------- what nothing above answered ----------
app.use(notFound);
app.use(errorHandler);

const port = Number(process.env.PORT ?? 8787);
const server = app.listen(port, () => {
  log.info(
    { version: VERSION.version, release: VERSION.release, commit: VERSION.commit },
    `api listening on http://localhost:${port}`,
  );
  logAdminPosture();
  if (mcpAuthMode() === "open") {
    log.warn(
      "MCP_OPEN=1: /mcp accepts unauthenticated callers, and their writes act on AGENT_USER_EMAIL",
    );
  }
  startInboxPoll();
  startPushScheduler();
  startDiscoveryScheduler();
  startRetentionSweep();
  startEvalSweep();
  warmupGuardrails();
  startMcpServer().catch((err) =>
    log.error({ err: String(err).slice(0, 300) }, "mcp failed to start"),
  );
});

// Shutdown order: loops stop, listening stops, chat streams are told, then
// these run in order, then the server closes. Ten seconds, cap included.
onShutdown("inbox realtime", stopInbox);
onShutdown("guardrail telemetry", flushGuardrailTelemetry);
onShutdown("langfuse", shutdownLangfuse);
onShutdown("mcp", stopMcpServer);
installShutdown(server, { timeoutMs: 10_000 });
