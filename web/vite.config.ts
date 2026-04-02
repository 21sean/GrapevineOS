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
