/**
 * The full-page routes that render outside the map shell. main.tsx decides
 * app-vs-standalone from this list, Standalone.tsx switches on the same
 * constants, and the links that point at these pages use them too, so a
 * renamed path changes in one place. public/_redirects and robots.txt name
 * them as well, in comments only: the SPA fallback covers every path.
 */
export const ROUTES = {
  privacy: "/privacy",
  terms: "/terms",
  oauthConsent: "/oauth/consent",
} as const

export const STANDALONE_PATHS: readonly string[] = Object.values(ROUTES)
