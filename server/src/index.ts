/**
 * The API server: one Express app, assembled from routers that each own one
 * banner below, plus the background loops that start once it listens.
 */
import "dotenv/config";
import express from "express";
import { logAdminPosture } from "./admin-gate.js";
import { chat } from "./agent/chat.js";
import { ext } from "./agent/ext.js";
import { warmupGuardrails } from "./agent/guardrails.js";
import { auth, requireAdmin } from "./auth.js";
import { calendar } from "./calendar.js";
import { startDiscoveryScheduler } from "./discovery.js";
import { startEvalSweep } from "./evals/auto-judge.js";
import { evals } from "./evals/index.js";
import { guardrails } from "./guardrails/index.js";
import { startInboxPoll } from "./inbox.js";
import { mcpAuthMode, startMcpServer } from "./mcp.js";
import { mcp } from "./mcp-proxy.js";
import { push, startPushScheduler } from "./push.js";
import { startRetentionSweep } from "./retention.js";
import { alerts } from "./routes/alerts.js";
import { discoveryRouter } from "./routes/discovery.js";
import { events } from "./routes/events.js";
import { inbox } from "./routes/inbox.js";
import { ingest } from "./routes/ingest.js";
import { mapbox } from "./routes/mapbox.js";
import { ollama } from "./routes/ollama.js";
import { providers } from "./routes/providers.js";
import { settings } from "./routes/settings.js";
import { validateSecrets } from "./secrets.js";

// Before anything listens: an example secret left in place is a
// misconfiguration worth a crash, not a warning scrolled past.
validateSecrets();

const app = express();
// Behind a tunnel/reverse proxy (the MCP connector path), X-Forwarded-Proto
// must win so OAuth discovery URLs come out https.
app.set("trust proxy", true);
// /mcp is reverse-proxied to the FastMCP listener verbatim, so its JSON-RPC
// body must stay an unread stream; everything else gets the usual parser.
const parseJson = express.json({ limit: "2mb" });
app.use((req, res, next) => (req.path === "/mcp" ? next() : parseJson(req, res, next)));

// ---------- auth (Supabase sign-in, /api/me, the admin gate) ----------
app.use(auth);

// ---------- calendar (saved events, Google sync, ICS feed) ----------
app.use(calendar);

// ---------- agent ("Ask Grapevine" chat, and the external tools API) ----------
app.use(chat);
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

const port = Number(process.env.PORT ?? 8787);
app.listen(port, () => {
  console.log(`[grapevine] api listening on http://localhost:${port}`);
  logAdminPosture();
  if (mcpAuthMode() === "open") {
    console.warn(
      "[grapevine] MCP_OPEN=1: /mcp accepts unauthenticated callers, and their writes act on AGENT_USER_EMAIL",
    );
  }
  startInboxPoll();
  startPushScheduler();
  startDiscoveryScheduler();
  startRetentionSweep();
  startEvalSweep();
  warmupGuardrails();
  startMcpServer().catch((err) =>
    console.error("[grapevine] mcp failed to start:", String(err).slice(0, 300)),
  );
});
