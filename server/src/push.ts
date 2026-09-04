/**
 * Web Push — reminders for saved events, traffic-aware "leave by" departure
 * alerts, and the Sunday-evening "your week" digest. Free and
 * serverless-friendly: the browser's push service does the delivery, we just
 * sign with VAPID keys minted on first boot and kept in Postgres (no env
 * setup).
 *
 * Scheduling is a one-minute tick, not a job queue: each tick loads the
 * subscriptions, finds saved events starting within the reminder window
 * (next occurrence, so weekly events remind weekly), and the push_sends
 * ledger guarantees each (user, event, occurrence) fires exactly once.
 * Digest pushes fire on the first tick after Sunday 5pm city time.
 *
 * Leave-by alerts watch events the user is going to (a "going" reaction or a
 * calendar save), ask Mapbox for the traffic-aware drive from the browser's
 * last reported position (or the city center), and fire once when it's time
 * to head out: leave-at = start − drive − a parking buffer. The ETA cache in
 * mapbox.ts keeps the per-tick cost inside the free tier.
 */
import { Router } from "express";
import webpush from "web-push";
import { affinityTerms } from "../../shared/affinity.js";
import { sessionUser } from "./auth.js";
import { isMutedFor, mutedSets, stringList, weekPicks } from "./digest.js";
import { eta } from "./mapbox.js";
import { nextOccurrence } from "./recurrence.js";
import { store } from "./store.js";
import type { CityEvent, PushSub } from "./types.js";
import { webOrigin } from "./urls.js";

const REMINDER_WINDOW_MIN = 45; // "starts soon" lead time
const TICK_MS = 60_000;
const DIGEST_DOW = "Sun";
const DIGEST_HOUR = 17;

const LEAVEBY_LOOKAHEAD_MIN = 180; // only price ETAs for events starting soon
const LEAVEBY_BUFFER_MIN = 10; // park, walk in, find the friends
const LEAVEBY_LEAD_MIN = 10; // fire when ≤10 min until you must leave
const POSITION_FRESH_MS = 12 * 60 * 60 * 1000; // stale position → city center

function clickBase(): string {
  return webOrigin();
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
    leaveBy: mine?.leaveBy ?? true,
    rareFinds: mine?.rareFinds ?? false, // the one opt-in alert
  });
});

push.post("/api/push/subscribe", async (req, res) => {
  const user = await sessionUser(req);
  if (!user) return res.status(401).json({ error: "not signed in" });
  const { subscription, reminders, weeklyDigest, leaveBy, rareFinds } = req.body ?? {};
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
      ...(typeof leaveBy === "boolean" && { leaveBy }),
      ...(typeof rareFinds === "boolean" && { rareFinds }),
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: String(err).slice(0, 200) });
  }
});

push.put("/api/push/prefs", async (req, res) => {
  const user = await sessionUser(req);
  if (!user) return res.status(401).json({ error: "not signed in" });
  const { endpoint, reminders, weeklyDigest, leaveBy, rareFinds } = req.body ?? {};
  if (typeof endpoint !== "string") return res.status(400).json({ error: "endpoint required" });
  try {
    await store.updatePushSubPrefs(user.id, endpoint, {
      ...(typeof reminders === "boolean" && { reminders }),
      ...(typeof weeklyDigest === "boolean" && { weeklyDigest }),
      ...(typeof leaveBy === "boolean" && { leaveBy }),
      ...(typeof rareFinds === "boolean" && { rareFinds }),
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: String(err).slice(0, 200) });
  }
});

/** Coarse origin for leave-by ETAs — the browser reports it after the user
 * grants geolocation; the store snaps it to ~110 m before it's written. */
push.post("/api/push/position", async (req, res) => {
  const user = await sessionUser(req);
  if (!user) return res.status(401).json({ error: "not signed in" });
  const lng = Number(req.body?.lng);
  const lat = Number(req.body?.lat);
  if (!Number.isFinite(lng) || !Number.isFinite(lat) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return res.status(400).json({ error: "lng + lat required" });
  }
  try {
    await store.setUserPosition(user.id, lng, lat);
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
      const payload: PushPayload = {
        title: `Starts soon: ${e.title}`,
        body: `${fmtTime(occ.start, tz)} · ${e.venue}${e.free ? " · Free" : ""}`,
        url: `${clickBase()}/?event=${encodeURIComponent(e.id)}`,
        tag: `reminder-${e.id}`,
      };
      await Promise.all(armed.map((s) => send(s, payload)));
    }
  }
}

function fmtTime(iso: string, tz: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));
}

function fmtDayTime(iso: string, tz: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));
}

/**
 * "Rare find" alerts — fired by the ingest pipeline the moment new events
 * commit, not by the minute tick. Strictly opt-in per browser, and only for
 * events that match the user's loves ("More like this" interests); avoided
 * terms, muted venues/sources, and promoted placements never notify. The
 * push_sends ledger keys per (user, event), so a re-ingest can't re-notify.
 */
export async function notifyRareFinds(added: CityEvent[]): Promise<void> {
  const now = new Date();
  const rare = added.filter((e) => e.rarity === "rare" && !e.promoted);
  if (!rare.length) return;

  const byUser = new Map<string, PushSub[]>();
  for (const s of await store.allPushSubs()) {
    if (s.rareFinds) byUser.set(s.userId, [...(byUser.get(s.userId) ?? []), s]);
  }
  if (!byUser.size) return;

  const { tz } = await store.settings();
  const upcoming = rare.filter((e) => Date.parse(nextOccurrence(e, now, tz).end) > now.getTime());
  if (!upcoming.length) return;

  for (const [userId, armed] of byUser) {
    const user = await store.userById(userId).catch(() => undefined);
    if (!user) continue;
    const interests = (user.prefs?.interests ?? {}) as { loves?: unknown; avoids?: unknown };
    const loves = new Set(stringList(interests.loves).map((t) => t.toLowerCase()));
    if (!loves.size) continue; // nothing to match against yet
    const avoids = new Set(stringList(interests.avoids).map((t) => t.toLowerCase()));
    const muted = mutedSets(user);

    const matches: CityEvent[] = [];
    for (const e of upcoming) {
      const terms = affinityTerms(e);
      if (!terms.some((t) => loves.has(t))) continue;
      if (terms.some((t) => avoids.has(t))) continue;
      if (isMutedFor(e, muted)) continue;
      if (!(await store.tryMarkSent(`rarefind|${userId}|${e.id}`))) continue;
      matches.push(e);
    }
    if (!matches.length) continue;

    const first = matches[0];
    const payload: PushPayload =
      matches.length === 1
        ? {
            title: `Rare find: ${first.title}`,
            body: `${fmtDayTime(nextOccurrence(first, now, tz).start, tz)} · ${first.venue}${first.free ? " · Free" : ""}`,
            url: `${clickBase()}/?event=${encodeURIComponent(first.id)}`,
            tag: `rarefind-${first.id}`,
          }
        : {
            title: `${matches.length} rare finds for you`,
            body: matches.slice(0, 4).map((e) => e.title).join(" · "),
            url: `${clickBase()}/?event=${encodeURIComponent(first.id)}`,
            tag: "rarefind",
          };
    await Promise.all(armed.map((s) => send(s, payload)));
  }
}

/**
 * Traffic-aware departure alerts for events the user is going to — a "going"
 * reaction or a calendar save, whichever they use. Fires once per occurrence
 * when now reaches leave-at − LEAVEBY_LEAD_MIN, and also claims the plain
 * reminder key so long drives don't double-notify (short drives keep the
 * 45-minute heads-up, then get the "go now" at the right moment).
 */
async function leaveByTick(
  subsByUser: Map<string, PushSub[]>,
  tz: string,
  center: [number, number],
): Promise<void> {
  const now = new Date();
  const events = await store.events();
  const byId = new Map(events.map((e) => [e.id, e]));
  for (const [userId, subs] of subsByUser) {
    const armed = subs.filter((s) => s.leaveBy);
    if (!armed.length) continue;

    const going = new Map<string, CityEvent>();
    for (const r of await store.userReactions(userId).catch(() => [])) {
      const e = r.reaction === "going" ? byId.get(r.eventId) : undefined;
      if (e) going.set(e.id, e);
    }
    for (const entry of await store.userCalendar(userId).catch(() => [])) {
      const e = byId.get(entry.eventId);
      if (e) going.set(e.id, e);
    }
    if (!going.size) continue;

    let origin: [number, number] | undefined;
    for (const e of going.values()) {
      const occ = nextOccurrence(e, now, tz);
      const minsToStart = (Date.parse(occ.start) - now.getTime()) / 60_000;
      if (minsToStart <= 0 || minsToStart > LEAVEBY_LOOKAHEAD_MIN) continue;

      if (!origin) {
        const pos = (await store.userById(userId).catch(() => undefined))?.lastPos;
        origin =
          pos && now.getTime() - Date.parse(pos.at) < POSITION_FRESH_MS
            ? [pos.lng, pos.lat]
            : center;
      }
      const drive = await eta(origin, [e.lng, e.lat]).catch(() => null);
      if (!drive) continue; // no route, no alert — the plain reminder still runs

      const leaveInMin = minsToStart - drive.minutes - LEAVEBY_BUFFER_MIN;
      if (leaveInMin > LEAVEBY_LEAD_MIN) continue;
      const key = `leaveby|${userId}|${e.id}|${occ.start}`;
      if (!(await store.tryMarkSent(key))) continue;
      await store.tryMarkSent(`reminder|${userId}|${e.id}|${occ.start}`).catch(() => {});

      const leaveAt = new Date(now.getTime() + leaveInMin * 60_000);
      const payload: PushPayload = {
        title:
          leaveInMin <= 0
            ? `Time to go — ${e.title}`
            : `Leave by ${fmtTime(leaveAt.toISOString(), tz)} — ${e.title}`,
        body: `${drive.minutes} min drive with traffic · starts ${fmtTime(occ.start, tz)} · ${e.venue}`,
        url: `${clickBase()}/?event=${encodeURIComponent(e.id)}`,
        tag: `leaveby-${e.id}`,
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
      const { tz, city, center } = await store.settings();
      // leave-by first: when both would fire on the same tick, the departure
      // alert claims the reminder key and the generic nudge stays quiet.
      await leaveByTick(byUser, tz, center);
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
  console.log(
    `[grapevine] push scheduler on — leave-by alerts (drive + ${LEAVEBY_BUFFER_MIN}min buffer), reminders ${REMINDER_WINDOW_MIN}min before start, digest ${DIGEST_DOW} ${DIGEST_HOUR}:00`,
  );
}
