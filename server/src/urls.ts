/**
 * The two public origins this server has to know about, each read in one
 * place. They differ: the web app is served by Vite in development and by a
 * static host in production, while the API (and the MCP endpoint on it) sits
 * on its own port or behind its own tunnel.
 */

/** Where the web app lives: calendar feed links and push notification URLs point here. */
export function webOrigin(): string {
  return (process.env.PUBLIC_BASE_URL ?? "http://localhost:5174").replace(/\/$/, "");
}

/**
 * Where this API is reachable from outside. Load-bearing for MCP OAuth: it is
 * the resource identifier clients validate, so MCP_PUBLIC_URL has to be set
 * whenever the server is not on http://localhost:PORT.
 */
export function apiOrigin(): string {
  const base = process.env.MCP_PUBLIC_URL ?? `http://localhost:${process.env.PORT ?? 8787}`;
  return base.replace(/\/$/, "");
}
