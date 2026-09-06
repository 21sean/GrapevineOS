import { lazy, StrictMode, Suspense } from "react"
import { createRoot } from "react-dom/client"

import "./index.css"
import App from "./App.tsx"
import { STANDALONE_PATHS } from "@/lib/routes"

// Web Push lives in the service worker; registration is idempotent and cheap.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {})
  })
}

// Full-page routes (OAuth consent, legal pages) render outside the map shell:
// no map, no store. Lazy so the main bundle path stays untouched for normal
// visits; the pathname switch itself lives in Standalone.
const Standalone = lazy(() => import("./components/Standalone.tsx"))
const isStandalone = STANDALONE_PATHS.includes(window.location.pathname)

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {isStandalone ? (
      <Suspense fallback={null}>
        <Standalone />
      </Suspense>
    ) : (
      <App />
    )}
  </StrictMode>
)
