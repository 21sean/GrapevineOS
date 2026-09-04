/**
 * Express front door for the MCP server: one public origin, forwarded to the
 * FastMCP listener on loopback.
 *
 * FastMCP owns its own HTTP server (mcp-proxy binds the port), so it runs on
 * 127.0.0.1 and this router reverse-proxies /mcp and the OAuth discovery
 * documents to it. That keeps MCP clients, the web app and the REST API on
 * the server's one port. Nothing here knows what the tools are; mcp.ts does.
 */
import http from "node:http";
import { Router, type Request, type Response } from "express";
import {
  AS_METADATA_PATH,
  INTERNAL_HOST,
  MCP_ENDPOINT,
  RESOURCE_METADATA_PATH,
  internalPort,
} from "./mcp.js";

/** Headers that describe the hop, not the message. */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/** Pipe one request through to FastMCP, streaming the response back. */
function forward(req: Request, res: Response, path: string): void {
  const port = internalPort();
  const headers: Record<string, string | string[]> = {
    ...(req.headers as Record<string, string | string[]>),
    host: `${INTERNAL_HOST}:${port}`,
  };
  for (const name of HOP_BY_HOP) delete headers[name];

  const upstream = http.request(
    { host: INTERNAL_HOST, port, method: req.method, path, headers },
    (up) => {
      res.status(up.statusCode ?? 502);
      for (const [name, value] of Object.entries(up.headers)) {
        if (value !== undefined && !HOP_BY_HOP.has(name)) res.setHeader(name, value);
      }
      if (!res.getHeader("access-control-allow-origin")) {
        res.setHeader("Access-Control-Allow-Origin", "*");
      }
      up.pipe(res);
    },
  );
  upstream.on("error", (err) => {
    if (res.headersSent) return res.end();
    res.status(503).json({
      jsonrpc: "2.0",
      error: { code: -32603, message: `mcp server unavailable: ${String(err).slice(0, 160)}` },
      id: null,
    });
  });
  // A client that hangs up must not leave a tool call running upstream.
  res.on("close", () => upstream.destroy());
  req.pipe(upstream);
}

export const mcp = Router();

// The MCP endpoint itself. index.ts leaves this path unparsed so the JSON-RPC
// body streams straight through.
mcp.all(MCP_ENDPOINT, (req, res) => forward(req, res, req.originalUrl));

/**
 * Discovery documents, served by FastMCP:
 *   - RFC 9728 protected-resource metadata at the bare path and the
 *     /mcp-suffixed variant clients derive from the resource URL's path.
 *   - The /mcp/-prefixed alias: mcp-proxy builds its 401 challenge by
 *     appending the well-known path to the resource identifier, so the
 *     challenge points at <origin>/mcp/.well-known/oauth-protected-resource.
 *     Mapping it back keeps the canonical resource id and a URL that resolves
 *     for every client.
 *   - RFC 8414 authorization-server metadata, a compatibility shim for
 *     pre-2025-06-18 clients that fetch it straight from the MCP origin.
 */
mcp.get(`${MCP_ENDPOINT}${RESOURCE_METADATA_PATH}`, (req, res) =>
  forward(req, res, `${RESOURCE_METADATA_PATH}${MCP_ENDPOINT}`),
);
mcp.get(
  [RESOURCE_METADATA_PATH, `${RESOURCE_METADATA_PATH}${MCP_ENDPOINT}`, AS_METADATA_PATH],
  (req, res) => forward(req, res, req.originalUrl),
);
