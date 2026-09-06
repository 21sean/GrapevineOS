import { lazy, Suspense } from "react"
import { ROUTES } from "@/lib/routes"

/**
 * Full-page routes that render outside the map app shell — the OAuth 2.1
 * consent screen and the legal pages. main.tsx decides app-vs-standalone from
 * the pathname and mounts this; each page is lazy so the map bundle never
 * carries them.
 */
const OAuthConsent = lazy(() => import("./OAuthConsent.tsx"))
const PrivacyPolicy = lazy(() =>
  import("./Legal.tsx").then((m) => ({ default: m.PrivacyPolicy }))
)
const TermsOfService = lazy(() =>
  import("./Legal.tsx").then((m) => ({ default: m.TermsOfService }))
)

export default function Standalone() {
  const path = window.location.pathname
  const page =
    path === ROUTES.privacy ? (
      <PrivacyPolicy />
    ) : path === ROUTES.terms ? (
      <TermsOfService />
    ) : (
      <OAuthConsent />
    )
  return <Suspense fallback={null}>{page}</Suspense>
}
