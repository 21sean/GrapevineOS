import { api } from "./api"

/**
 * Browser side of Web Push: service-worker registration happens in main.tsx;
 * this wraps the permission → subscribe → tell-the-server dance for the
 * notification toggles in AccountDialog.
 */

export function pushSupported(): boolean {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window
}

/** The applicationServerKey format subscribe() wants. */
function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4)
  const raw = atob((base64 + padding).replace(/-/g, "+").replace(/_/g, "/"))
  return Uint8Array.from(raw, (c) => c.charCodeAt(0))
}

export async function currentSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null
  const reg = await navigator.serviceWorker.getRegistration()
  if (!reg) return null
  return reg.pushManager.getSubscription()
}

/**
 * Ensure this browser has a push subscription (asking permission if needed)
 * and hand it to the server bound to the signed-in account.
 */
export async function enablePush(prefs: {
  reminders?: boolean
  weeklyDigest?: boolean
  leaveBy?: boolean
  rareFinds?: boolean
}): Promise<PushSubscription> {
  if (!pushSupported()) throw new Error("this browser doesn't support notifications")
  const permission = await Notification.requestPermission()
  if (permission !== "granted") {
    throw new Error("notifications are blocked — allow them in your browser's site settings")
  }
  const reg =
    (await navigator.serviceWorker.getRegistration()) ??
    (await navigator.serviceWorker.register("/sw.js"))
  await navigator.serviceWorker.ready
  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array((await api.pushKey()).publicKey) as BufferSource,
    }))
  await api.pushSubscribe(sub.toJSON(), prefs)
  return sub
}

/** Drop the subscription in the browser and on the server. */
export async function disablePush(): Promise<void> {
  const sub = await currentSubscription()
  if (!sub) return
  await api.pushUnsubscribe(sub.endpoint).catch(() => {})
  await sub.unsubscribe().catch(() => {})
}
