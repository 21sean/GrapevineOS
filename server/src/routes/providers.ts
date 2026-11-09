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
import { hostedModel, runHostedWorker } from "../llm/hosted.js";
import { generateTyped } from "../llm/gateway.js";
import { isHostedProvider, type HostedProviderStatus } from "../types.js";
import { rateLimit } from "../rate-limit.js";

export const providers = Router();

providers.get("/api/providers", requireAdmin, async (_req, res) => {
  const statuses = JSON.parse(await runHostedWorker({})) as Omit<HostedProviderStatus, "model">[];
  res.json(statuses.map((status) => ({ ...status, model: hostedModel(status.id) })));
});

providers.post(
  "/api/providers/:id/test",
  requireAdmin,
  rateLimit({ name: "provider-test", windowMs: 60_000, max: 4 }),
  async (req, res) => {
    const provider = req.params.id;
    if (!isHostedProvider(provider)) return res.status(400).json({ error: "Unsupported provider" });
    try {
      await generateTyped({
        provider,
        model: hostedModel(provider),
        task: "summary",
        messages: [{ role: "user", content: 'Return a JSON object with summary: "Connected".' }],
        signal: AbortSignal.any([AbortSignal.timeout(120_000), requestSignal(res)]),
      });
      res.json({ ok: true });
    } catch (error) {
      res
        .status(503)
        .json({ error: error instanceof Error ? error.message : "Provider test failed" });
    }
  },
);

function requestSignal(res: import("express").Response): AbortSignal {
  const controller = new AbortController();
  res.once("close", () => {
    if (!res.writableEnded) controller.abort();
  });
  return controller.signal;
}

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
