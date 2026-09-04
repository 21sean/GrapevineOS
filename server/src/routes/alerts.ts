/**
 * Where the self-hosted Langfuse posts alert notifications (Alerts, webhook
 * channel; see observability/langfuse). Logged so an alert firing is visible
 * in the server console next to the traffic that caused it.
 */
import { Router } from "express";
import { safeEqual } from "../secrets.js";

export const alerts = Router();

alerts.post("/api/alerts/langfuse", (req, res) => {
  // The key rides in a header rather than the query string: query strings
  // land in access logs and in the caddy bridge's output, headers do not.
  if (!safeEqual(req.get("X-Ingest-Key"), process.env.INGEST_SHARED_KEY)) {
    return res.status(401).json({ error: "bad key" });
  }
  const body = JSON.stringify(req.body ?? {});
  console.warn(`[grapevine] langfuse alert: ${body.slice(0, 600)}`);
  res.json({ ok: true });
});
