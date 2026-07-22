import { useEffect, useState } from "react"
import { toast } from "sonner"
import { api } from "@/lib/api"
import {
  currentSubscription,
  disablePush,
  enablePush,
  pushSupported,
} from "@/lib/push"

export interface PushState {
  supported: boolean
  subscribed: boolean
  reminders: boolean
  weeklyDigest: boolean
  leaveBy: boolean
}

export type PushKind = "reminders" | "weeklyDigest" | "leaveBy"

/**
 * Web Push state machine for THIS browser (subscriptions are per-device).
 * Support is knowable synchronously; the subscription itself resolves in an
 * effect that runs while `active` (e.g. the account dialog is open).
 * `togglePush` drives the permission → subscribe → prefs dance.
 */
export function usePush(active: boolean): {
  pushState: PushState | null
  pushBusy: boolean
  togglePush: (kind: PushKind, value: boolean) => Promise<void>
} {
  const [pushState, setPushState] = useState<PushState | null>(() =>
    pushSupported()
      ? null
      : {
          supported: false,
          subscribed: false,
          reminders: false,
          weeklyDigest: false,
          leaveBy: false,
        }
  )
  const [pushBusy, setPushBusy] = useState(false)

  useEffect(() => {
    if (!active || !pushSupported()) return
    let cancelled = false
    void (async () => {
      const sub = await currentSubscription().catch(() => null)
      const status = sub
        ? await api.pushStatus(sub.endpoint).catch(() => null)
        : null
      if (cancelled) return
      setPushState({
        supported: true,
        subscribed: !!status?.subscribed,
        reminders: !!status?.subscribed && status.reminders,
        weeklyDigest: !!status?.subscribed && status.weeklyDigest,
        leaveBy: !!status?.subscribed && status.leaveBy,
      })
    })()
    return () => {
      cancelled = true
    }
  }, [active])

  async function togglePush(kind: PushKind, value: boolean) {
    if (!pushState || pushBusy) return
    const next = { ...pushState, [kind]: value }
    setPushBusy(true)
    try {
      if (value && !pushState.subscribed) {
        // first toggle on this device: permission prompt + subscribe
        await enablePush({
          reminders: next.reminders,
          weeklyDigest: next.weeklyDigest,
          leaveBy: next.leaveBy,
        })
        next.subscribed = true
        toast.success("Notifications on for this browser")
      } else if (!next.reminders && !next.weeklyDigest && !next.leaveBy) {
        await disablePush()
        next.subscribed = false
      } else {
        const sub = await currentSubscription()
        if (sub)
          await api.pushPrefs(sub.endpoint, {
            reminders: next.reminders,
            weeklyDigest: next.weeklyDigest,
            leaveBy: next.leaveBy,
          })
      }
      setPushState(next)
    } catch (err) {
      toast.error("Couldn't update notifications", {
        description: String(err instanceof Error ? err.message : err).slice(
          0,
          140
        ),
      })
    } finally {
      setPushBusy(false)
    }
  }

  return { pushState, pushBusy, togglePush }
}
