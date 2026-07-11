import { lazy, StrictMode, Suspense } from "react"
import { createRoot } from "react-dom/client"

import "./index.css"
import App from "./App.tsx"

// Web Push lives in the service worker; registration is idempotent and cheap.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {})
  })
}

// The OAuth 2.1 consent page (Supabase redirects MCP clients' users here)
// renders standalone — no map, no store, no app shell. Lazy so the main
// bundle path stays untouched for normal visits.
const OAuthConsent = lazy(() => import("./components/OAuthConsent.tsx"))
const isConsent = window.location.pathname === "/oauth/consent"

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {isConsent ? (
      <Suspense fallback={null}>
        <OAuthConsent />
      </Suspense>
    ) : (
      <App />
    )}
  </StrictMode>
)
