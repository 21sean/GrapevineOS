/**
 * The local runtime chat and extraction generate on, and where MCP clients
 * connect. Both feed Admin, Providers, so both are admin-only.
 */
import { Router } from "express";
import { requireAdmin } from "../auth.js";
import { llmBase, llmModel, llmRuntime, runtimeLabel, runtimeVersion } from "../llm/runtime.js";
import { MCP_ENDPOINT, mcpAuthMode } from "../mcp.js";
import { store } from "../store.js";
import type { LocalRuntimeStatus, McpInfo } from "../types.js";
import { apiOrigin } from "../urls.js";

export const providers = Router();

providers.get("/api/runtime", requireAdmin, async (_req, res) => {
  const url = await llmBase();
  const status: LocalRuntimeStatus = {
    id: llmRuntime(),
    name: runtimeLabel(),
    url,
    version: await runtimeVersion(url),
    model: llmModel((await store.settings()).model),
  };
  res.json(status);
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
