/**
 * Grapevine service worker: Web Push only (no offline caching; the app is a
 * live map and stale tiles are worse than no tiles).
 *
 * Payloads come from server/src/push.ts as JSON:
 *   { title, body, url?, tag? }
 * url is a deep link (/?event=<id> or /?digest=week) that App.tsx unpacks.
 */

self.addEventListener("install", () => self.skipWaiting())
self.addEventListener("activate", (event) =>
  event.waitUntil(self.clients.claim())
)

self.addEventListener("push", (event) => {
  let data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch {
    data = { body: event.data ? event.data.text() : "" }
  }
  event.waitUntil(
    self.registration.showNotification(data.title || "Grapevine", {
      body: data.body || "",
      tag: data.tag || undefined,
      icon: "/grapevine.svg",
      badge: "/grapevine.svg",
      data: { url: data.url || "/" },
    })
  )
})

self.addEventListener("notificationclick", (event) => {
  event.notification.close()
  const url = (event.notification.data && event.notification.data.url) || "/"
  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((windows) => {
        // reuse an open Grapevine tab when there is one
        for (const client of windows) {
          if (new URL(client.url).origin === self.location.origin) {
            client.navigate(url)
            return client.focus()
          }
        }
        return self.clients.openWindow(url)
      })
  )
})
