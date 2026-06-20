/**
 * Web Push — reminders for saved events and the Sunday-evening "your week"
 * digest. Free and serverless-friendly: the browser's push service does the
 * delivery, we just sign with VAPID keys minted on first boot and kept in
 * Postgres (no env setup).
 *
 * Scheduling is a one-minute tick, not a job queue: each tick loads the
 * subscriptions, finds saved events starting within the reminder window
 * (next occurrence, so weekly events remind weekly), and the push_sends
 * ledger guarantees each (user, event, occurrence) fires exactly once.
 * Digest pushes fire on the first tick after Sunday 5pm city time.
 */
import { Router } from "express";
import webpush from "web-push";
import { sessionUser } from "./auth.js";
import { weekPicks } from "./digest.js";
import { nextOccurrence } from "./recurrence.js";
import { store } from "./store.js";
import type { PushSub } from "./types.js";

const REMINDER_WINDOW_MIN = 45; // "starts soon" lead time
const TICK_MS = 60_000;
const DIGEST_DOW = "Sun";
const DIGEST_HOUR = 17;

function clickBase(): string {
  return (process.env.PUBLIC_BASE_URL ?? "http://localhost:5174").replace(/\/$/, "");
}

let vapidReady: Promise<string> | null = null;

/** Public key for the browser's subscribe call; mints the pair on first use. */
function ensureVapid(): Promise<string> {
  vapidReady ??= (async () => {
    let keys = await store.pushKeys();
    if (!keys) {
      await store.savePushKeys(webpush.generateVAPIDKeys());
      keys = (await store.pushKeys())!; // re-read: a boot race may have won
    }
    webpush.setVapidDetails("mailto:push@grapevine.local", keys.publicKey, keys.privateKey);
    return keys.publicKey;
  })();
  return vapidReady;
}

interface PushPayload {
  title: string;
  body: string;
  url?: string;
  tag?: string;
}

/** Send one notification; a dead endpoint (404/410) is dropped, not retried. */
async function send(sub: PushSub, payload: PushPayload): Promise<void> {
  await ensureVapid();
  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      JSON.stringify(payload),
      { TTL: 3600 },
    );
  } catch (err) {
    const code = (err as { statusCode?: number }).statusCode;
    if (code === 404 || code === 410) {
      await store.deletePushEndpoint(sub.endpoint).catch(() => {});
    } else {
      console.log(`[grapevine] push failed (${code ?? err}): ${String(err).slice(0, 120)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export const push = Router();

push.get("/api/push/key", async (_req, res) => {
  try {
    res.json({ publicKey: await ensureVapid() });
  } catch (err) {
    res.status(502).json({ error: String(err).slice(0, 200) });
  }
});

/** This user's subscription state for the endpoint the browser holds. */
push.post("/api/push/status", async (req, res) => {
  const user = await sessionUser(req);
  if (!user) return res.status(401).json({ error: "not signed in" });
  const endpoint = String(req.body?.endpoint ?? "");
  const subs = await store.pushSubsForUser(user.id).catch(() => []);
  const mine = subs.find((s) => s.endpoint === endpoint);
  res.json({
    subscribed: !!mine,
    reminders: mine?.reminders ?? true,
    weeklyDigest: mine?.weeklyDigest ?? true,
  });
});

push.post("/api/push/subscribe", async (req, res) => {
  const user = await sessionUser(req);
  if (!user) return res.status(401).json({ error: "not signed in" });
  const { subscription, reminders, weeklyDigest } = req.body ?? {};
  const endpoint = subscription?.endpoint;
  const p256dh = subscription?.keys?.p256dh;
  const auth = subscription?.keys?.auth;
  if (typeof endpoint !== "string" || typeof p256dh !== "string" || typeof auth !== "string") {
    return res.status(400).json({ error: "subscription with endpoint + keys required" });
  }
  try {
    await store.upsertPushSub({
      userId: user.id,
      endpoint,
      p256dh,
      auth,
      ...(typeof reminders === "boolean" && { reminders }),
      ...(typeof weeklyDigest === "boolean" && { weeklyDigest }),
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: String(err).slice(0, 200) });
  }
});

push.put("/api/push/prefs", async (req, res) => {
  const user = await sessionUser(req);
  if (!user) return res.status(401).json({ error: "not signed in" });
  const { endpoint, reminders, weeklyDigest } = req.body ?? {};
  if (typeof endpoint !== "string") return res.status(400).json({ error: "endpoint required" });
  try {
    await store.updatePushSubPrefs(user.id, endpoint, {
      ...(typeof reminders === "boolean" && { reminders }),
      ...(typeof weeklyDigest === "boolean" && { weeklyDigest }),
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: String(err).slice(0, 200) });
  }
});

push.delete("/api/push/subscribe", async (req, res) => {
  const user = await sessionUser(req);
  if (!user) return res.status(401).json({ error: "not signed in" });
  const endpoint = String(req.body?.endpoint ?? "");
  if (!endpoint) return res.status(400).json({ error: "endpoint required" });
  try {
    await store.deletePushSub(user.id, endpoint);
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: String(err).slice(0, 200) });
  }
});

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

function localParts(now: Date, tz: string): { dow: string; hour: number; day: string } {
  const dow = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(now);
  const hour = Number(
    new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hourCycle: "h23" }).format(now),
  );
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(now);
  return { dow, hour, day };
}

async function remindersTick(subsByUser: Map<string, PushSub[]>, tz: string): Promise<void> {
  const now = new Date();
  const events = await store.events();
  const byId = new Map(events.map((e) => [e.id, e]));
  for (const [userId, subs] of subsByUser) {
    const armed = subs.filter((s) => s.reminders);
    if (!armed.length) continue;
    const entries = await store.userCalendar(userId).catch(() => []);
    for (const entry of entries) {
      const e = byId.get(entry.eventId);
      if (!e) continue;
      const occ = nextOccurrence(e, now, tz);
      const minsToStart = (Date.parse(occ.start) - now.getTime()) / 60_000;
      if (minsToStart <= 0 || minsToStart > REMINDER_WINDOW_MIN) continue;
      const key = `reminder|${userId}|${e.id}|${occ.start}`;
      if (!(await store.tryMarkSent(key))) continue;
      const when = new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        hour: "numeric",
        minute: "2-digit",
      }).format(new Date(occ.start));
      const payload: PushPayload = {
        title: `Starts soon: ${e.title}`,
        body: `${when} · ${e.venue}${e.free ? " · Free" : ""}`,
        url: `${clickBase()}/?event=${encodeURIComponent(e.id)}`,
        tag: `reminder-${e.id}`,
      };
      await Promise.all(armed.map((s) => send(s, payload)));
    }
  }
}

async function digestTick(subsByUser: Map<string, PushSub[]>, tz: string, city: string): Promise<void> {
  const { dow, hour, day } = localParts(new Date(), tz);
  if (dow !== DIGEST_DOW || hour < DIGEST_HOUR) return;
  for (const [userId, subs] of subsByUser) {
    const armed = subs.filter((s) => s.weeklyDigest);
    if (!armed.length) continue;
    const key = `digest|${userId}|${day}`;
    if (!(await store.tryMarkSent(key))) continue;
    const user = await store.userById(userId);
    if (!user) continue;
    const { picks } = await weekPicks(user, 3);
    if (!picks.length) continue;
    const payload: PushPayload = {
      title: `Your week in ${city.split(",")[0]}`,
      body: picks.map((p) => `${p.title} (${p.when})`).join(" · "),
      url: `${clickBase()}/?digest=week`,
      tag: "weekly-digest",
    };
    await Promise.all(armed.map((s) => send(s, payload)));
  }
}

let running = false;

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const subs = await store.allPushSubs();
    if (subs.length) {
      const byUser = new Map<string, PushSub[]>();
      for (const s of subs) byUser.set(s.userId, [...(byUser.get(s.userId) ?? []), s]);
      const { tz, city } = await store.settings();
      await remindersTick(byUser, tz);
      await digestTick(byUser, tz, city);
    }
  } catch (err) {
    console.log(`[grapevine] push tick error: ${String(err).slice(0, 200)}`);
  } finally {
    running = false;
  }
}

export function startPushScheduler(): void {
  if (/^(0|false|no)$/i.test(process.env.PUSH_SCHEDULER ?? "")) {
    console.log("[grapevine] push scheduler disabled (PUSH_SCHEDULER=0)");
    return;
  }
  setInterval(() => void tick(), TICK_MS);
  console.log(`[grapevine] push scheduler on — reminders ${REMINDER_WINDOW_MIN}min before start, digest ${DIGEST_DOW} ${DIGEST_HOUR}:00`);
}
