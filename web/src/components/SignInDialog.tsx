import { useState } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Spinner } from "@/components/ui/spinner"
import { signInWithProvider, supabase, type OAuthProvider } from "@/lib/supabase"
import { useGrapevine } from "@/lib/store"

/**
 * Provider picker — Supabase Auth runs the PKCE flow, so each button is a
 * full-page redirect out to the provider and back. Apple can slot in here
 * later with one more button once its Services ID is configured.
 */
export function SignInDialog() {
  const open = useGrapevine((s) => s.signInOpen)
  const setOpen = useGrapevine((s) => s.setSignInOpen)
  const [busy, setBusy] = useState<OAuthProvider | null>(null)

  async function go(provider: OAuthProvider) {
    if (busy) return
    setBusy(provider)
    try {
      await signInWithProvider(provider) // navigates away on success
    } catch (err) {
      toast.error("Couldn't start sign-in", {
        description: String(err instanceof Error ? err.message : err).slice(0, 140),
      })
      setBusy(null)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-xs">
        <DialogHeader>
          <DialogTitle className="font-heading text-xl">Sign in</DialogTitle>
          <DialogDescription>
            Your calendar, interests and reactions follow your account across
            devices.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          <Button
            variant="secondary"
            disabled={!supabase || !!busy}
            onClick={() => void go("google")}
          >
            {busy === "google" ? <Spinner data-icon="inline-start" /> : <GoogleIcon />}
            Continue with Google
          </Button>
          <Button
            variant="secondary"
            disabled={!supabase || !!busy}
            onClick={() => void go("github")}
          >
            {busy === "github" ? <Spinner data-icon="inline-start" /> : <GitHubIcon />}
            Continue with GitHub
          </Button>
          {!supabase && (
            <p className="text-xs text-muted-foreground">
              Sign-in isn't configured — set VITE_SUPABASE_URL and
              VITE_SUPABASE_PUBLISHABLE_KEY in web/.env.local.
            </p>
          )}
        </div>
        <p className="text-center text-xs text-muted-foreground">
          By continuing you agree to our{" "}
          <a className="underline underline-offset-2 hover:text-foreground" href="/terms">
            Terms
          </a>{" "}
          and{" "}
          <a className="underline underline-offset-2 hover:text-foreground" href="/privacy">
            Privacy Policy
          </a>
          .
        </p>
      </DialogContent>
    </Dialog>
  )
}

/** Google "G" in brand colors, sized to match lucide icons. */
export function GoogleIcon() {
  return (
    <svg viewBox="0 0 48 48" aria-hidden="true" data-icon="inline-start">
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
    </svg>
  )
}

/** GitHub mark, monochrome (currentColor). */
export function GitHubIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" data-icon="inline-start" fill="currentColor">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
    </svg>
  )
}
