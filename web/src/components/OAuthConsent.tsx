import { useEffect, useState } from "react"
import type { Session } from "@supabase/supabase-js"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import { Spinner } from "@/components/ui/spinner"
import { GitHubIcon, GoogleIcon } from "@/components/SignInDialog"
import { signInWithProvider, supabase, type OAuthProvider } from "@/lib/supabase"

/**
 * OAuth 2.1 consent page — the authorization UI Supabase Auth redirects to
 * when an OAuth client (an MCP client like Claude, via a custom connector)
 * asks for access. Rendered standalone at /oauth/consent (see main.tsx); the
 * map app never loads here.
 *
 * Flow: Supabase lands the user here with ?authorization_id=…; we make sure
 * they're signed in (same Google/GitHub PKCE flow as the app, round-tripping
 * this URL), fetch the client details, and approve/deny. Both decisions end
 * in a redirect back to the requesting client with a code or an error.
 */

/** What each scope means in plain words, for the consent card. */
const SCOPE_LABELS: Record<string, string> = {
  openid: "Confirm who you are",
  email: "See your email address",
  profile: "See your name and picture",
}

type Phase =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "signin" }
  | {
      kind: "consent"
      client: { name: string; uri?: string; logo_uri?: string }
      scopes: string[]
      email: string
    }

export function OAuthConsent() {
  const authorizationId = new URLSearchParams(window.location.search).get("authorization_id")
  const [phase, setPhase] = useState<Phase>({ kind: "loading" })
  const [session, setSession] = useState<Session | null | undefined>(undefined)
  const [busy, setBusy] = useState<"approve" | "deny" | OAuthProvider | null>(null)

  // Session tracking: getSession answers immediately; onAuthStateChange also
  // catches the async code-for-session exchange when we land back here from
  // the sign-in redirect (detectSessionInUrl).
  useEffect(() => {
    if (!supabase) return
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => setSession(s))
    supabase.auth.getSession().then(({ data }) => {
      setSession((prev) => (prev === undefined ? data.session : prev))
    })
    return () => sub.subscription.unsubscribe()
  }, [])

  // Once we know who's asking and who's signed in, fetch the request details.
  useEffect(() => {
    if (!supabase) {
      setPhase({ kind: "error", message: "Sign-in isn't configured on this Grapevine." })
      return
    }
    if (!authorizationId) {
      setPhase({
        kind: "error",
        message:
          "Missing authorization_id — this page only works as part of an app's connection request.",
      })
      return
    }
    if (session === undefined) return // still resolving
    if (session === null) {
      setPhase({ kind: "signin" })
      return
    }
    let cancelled = false
    void supabase.auth.oauth.getAuthorizationDetails(authorizationId).then(({ data, error }) => {
      if (cancelled) return
      if (error || !data) {
        setPhase({
          kind: "error",
          message: error?.message ?? "Invalid or expired authorization request.",
        })
      } else if (!("authorization_id" in data)) {
        // Already consented earlier — straight back to the client.
        window.location.href = data.redirect_url
      } else {
        setPhase({
          kind: "consent",
          client: data.client,
          scopes: (data.scope ?? "").split(" ").filter(Boolean),
          email: data.user.email,
        })
      }
    })
    return () => {
      cancelled = true
    }
  }, [authorizationId, session])

  async function signIn(provider: OAuthProvider) {
    if (busy) return
    setBusy(provider)
    try {
      await signInWithProvider(provider, window.location.href) // navigates away
    } catch (err) {
      setBusy(null)
      setPhase({ kind: "error", message: String(err instanceof Error ? err.message : err) })
    }
  }

  async function decide(decision: "approve" | "deny") {
    if (!supabase || !authorizationId || busy) return
    setBusy(decision)
    const call =
      decision === "approve"
        ? supabase.auth.oauth.approveAuthorization(authorizationId, { skipBrowserRedirect: true })
        : supabase.auth.oauth.denyAuthorization(authorizationId, { skipBrowserRedirect: true })
    const { data, error } = await call
    if (error || !data) {
      setBusy(null)
      setPhase({ kind: "error", message: error?.message ?? "The decision didn't go through." })
      return
    }
    window.location.href = data.redirect_url
  }

  return (
    <main className="flex min-h-dvh items-center justify-center bg-background p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <span className="font-heading text-sm font-semibold italic tracking-tight text-muted-foreground">
            Grapevine
          </span>
          {phase.kind === "consent" ? (
            <>
              <CardTitle className="font-heading text-xl">
                Allow {phase.client.name || "this app"}?
              </CardTitle>
              <CardDescription>
                It wants to connect to your Grapevine account — search events, save to your
                calendar, and tune your interests as you.
              </CardDescription>
            </>
          ) : phase.kind === "signin" ? (
            <>
              <CardTitle className="font-heading text-xl">Sign in to continue</CardTitle>
              <CardDescription>
                An app is asking to connect to Grapevine. Sign in first so the access is tied to
                your account.
              </CardDescription>
            </>
          ) : (
            <CardTitle className="font-heading text-xl">
              {phase.kind === "error" ? "Can't continue" : "One moment"}
            </CardTitle>
          )}
        </CardHeader>

        <CardContent className="flex flex-col gap-3">
          {phase.kind === "loading" && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner /> Checking the request…
            </div>
          )}

          {phase.kind === "error" && (
            <p className="text-sm text-muted-foreground">{phase.message}</p>
          )}

          {phase.kind === "signin" && (
            <>
              <Button variant="secondary" disabled={!!busy} onClick={() => void signIn("google")}>
                {busy === "google" ? <Spinner data-icon="inline-start" /> : <GoogleIcon />}
                Continue with Google
              </Button>
              <Button variant="secondary" disabled={!!busy} onClick={() => void signIn("github")}>
                {busy === "github" ? <Spinner data-icon="inline-start" /> : <GitHubIcon />}
                Continue with GitHub
              </Button>
            </>
          )}

          {phase.kind === "consent" && (
            <>
              {phase.scopes.length > 0 && (
                <ul className="flex flex-col gap-1.5 text-sm">
                  {phase.scopes.map((s) => (
                    <li key={s} className="flex items-baseline gap-2">
                      <span className="size-1.5 shrink-0 translate-y-[-1px] rounded-full bg-wine" />
                      {SCOPE_LABELS[s] ?? s}
                    </li>
                  ))}
                </ul>
              )}
              <Separator />
              <p className="text-xs text-muted-foreground">
                Signed in as <span className="font-medium text-foreground">{phase.email}</span>.
                Everything the app does here happens as your account, and you can disconnect it
                any time from the app's own settings.
              </p>
            </>
          )}
        </CardContent>

        {phase.kind === "consent" && (
          <CardFooter className="flex gap-2">
            <Button
              variant="outline"
              className="flex-1"
              disabled={!!busy}
              onClick={() => void decide("deny")}
            >
              {busy === "deny" && <Spinner data-icon="inline-start" />}
              Deny
            </Button>
            <Button className="flex-1" disabled={!!busy} onClick={() => void decide("approve")}>
              {busy === "approve" && <Spinner data-icon="inline-start" />}
              Approve
            </Button>
          </CardFooter>
        )}
      </Card>
    </main>
  )
}

export default OAuthConsent
