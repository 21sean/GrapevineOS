import path from "path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { createLogger, defineConfig, type ProxyOptions } from "vite"

// The API (server/) is a tsx process that loads a heavy dependency graph
// (transformers, langgraph, jsdom…) before it binds port 8787, and `tsx watch`
// restarts it on every server-file save. Vite serves instantly, so any request
// proxied to /api or /auth during that boot/restart window hits a closed port
// and fails with ECONNREFUSED. It's harmless — the next request succeeds once
// the API is listening — but Vite logs the full AggregateError stack for every
// miss, which drowns out real errors. Collapse those into one tidy note.
const logger = createLogger()
const logError = logger.error
logger.error = (msg, opts) => {
  const code = (opts?.error as NodeJS.ErrnoException | undefined)?.code
  if (code === "ECONNREFUSED" && msg.includes("proxy error")) {
    logger.warnOnce(
      "[vite] api (localhost:8787) isn't up yet — proxied requests fail until " +
        "it binds. Normal on startup and while `tsx watch` restarts the server."
    )
    return
  }
  logError(msg, opts)
}

// Reply to the browser with a clean 503 while the API is still coming up, so
// the network tab reads "api starting" instead of a bare socket failure.
const whileApiBoots: ProxyOptions["configure"] = (proxy) => {
  proxy.on("error", (err, _req, res) => {
    if ((err as NodeJS.ErrnoException).code !== "ECONNREFUSED") return
    if (res && "writeHead" in res && !res.headersSent && !res.writableEnded) {
      res.writeHead(503, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ error: "api starting" }))
    }
  })
}

const api: ProxyOptions = {
  target: "http://localhost:8787",
  configure: whileApiBoots,
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  customLogger: logger,
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    rollupOptions: {
      output: {
        // Deps change on dependency bumps, app code on every deploy — split
        // them so returning visitors only re-download the small app chunk.
        // mapbox-gl gets its own chunk: it's the bulk of the payload and lets
        // the browser fetch it in parallel with the rest.
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined
          return id.includes("mapbox-gl") ? "mapbox" : "vendor"
        },
      },
    },
  },
  server: {
    // Supabase Auth redirects back to this origin after OAuth — keep the
    // dev port pinned so it stays on the project's redirect allow-list.
    port: 5174,
    strictPort: true,
    proxy: {
      "/api": api,
    },
  },
})
