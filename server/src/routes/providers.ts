/**
 * Chat providers (the subscription CLIs) and where MCP clients connect. Both
 * feed Admin, Providers, so both are admin-only.
 */
import { Router } from "express";
import { requireAdmin } from "../auth.js";
import { MCP_ENDPOINT, mcpAuthMode } from "../mcp.js";
import { detectProviders } from "../providers.js";
import type { McpInfo } from "../types.js";
import { apiOrigin } from "../urls.js";

export const providers = Router();

providers.get("/api/providers", requireAdmin, async (req, res) => {
  try {
    const force = req.query.refresh === "1";
    res.json({ providers: await detectProviders(force) });
  } catch (err) {
    res.status(502).json({ error: String(err) });
  }
});

providers.get("/api/mcp/info", requireAdmin, (_req, res) => {
  // /mcp is served by this express app directly (not proxied through the web
  // origin), so an MCP client connects to the API origin.
  const url = `${apiOrigin()}${MCP_ENDPOINT}`;
  const info: McpInfo = {
    url,
    transport: "http",
    // "oauth": clients sign in via the Supabase-backed consent flow (or send
    // AGENT_API_KEY as a header for headless scripts). "open": MCP_OPEN=1.
    auth: mcpAuthMode(),
    connectorUrl: url,
  };
  res.json(info);
});
