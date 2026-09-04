/**
 * What the chat can do right now, for the popover next to the composer: who
 * answers, whether it has tools, which ones, whether the rails are on, and
 * where an MCP client connects to the same toolbox.
 *
 * Public on purpose. It names the model and the tools, which the model's own
 * answers reveal anyway, and nothing here can spend quota or read data.
 */
import { Router } from "express";
import { toolsFor } from "../agent/contracts.js";
import { classifierReady, guardConfig } from "../agent/guardrails.js";
import { MCP_ENDPOINT, mcpAuthMode } from "../mcp.js";
import { modelSupportsTools } from "../ollama.js";
import { cliSupportsTools } from "../providers.js";
import { store } from "../store.js";
import type { AgentCapabilities } from "../types.js";
import { apiOrigin } from "../urls.js";

export const capabilities = Router();

capabilities.get("/api/agent/capabilities", async (_req, res) => {
  const [settings, guard] = await Promise.all([store.settings(), guardConfig()]);
  const provider = settings.chatProvider;
  let tools = false;
  let surface: "graph" | "mcp" | null = null;
  if (provider === "ollama") {
    tools = settings.model ? await modelSupportsTools(settings.model).catch(() => false) : false;
    surface = tools ? "graph" : null;
  } else {
    // A CLI brings its own toolbox: this server's MCP surface, when it can.
    tools = cliSupportsTools(provider);
    surface = tools ? "mcp" : null;
  }
  const body: AgentCapabilities = {
    provider,
    model: provider === "ollama" ? settings.model : "",
    tools,
    toolbox: surface
      ? toolsFor(surface).map((c) => ({ name: c.name, description: c.description, effect: c.effect }))
      : [],
    rails: {
      mode: guard.mode,
      classifier: guard.mode === "off" ? "off" : classifierReady() ? "ready" : "failing-open",
    },
    mcp: { url: `${apiOrigin()}${MCP_ENDPOINT}`, auth: mcpAuthMode() },
  };
  res.json(body);
});
