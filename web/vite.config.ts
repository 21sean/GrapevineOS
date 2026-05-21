import path from "path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
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
    // The Google OAuth client is registered for http://localhost:5174 —
    // keep the dev origin pinned so sign-in redirects keep working.
    port: 5174,
    strictPort: true,
    proxy: {
      "/api": "http://localhost:8787",
      "/auth": "http://localhost:8787",
    },
  },
})
