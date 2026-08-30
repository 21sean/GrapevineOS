/**
 * Retention sweep: old events don't belong in the catalog.
 *
 * Every display surface already hides ended events (the web list, the agent
 * digest, the inbox history), so this is DB hygiene: without it the events
 * table grows forever and every client downloads all of history on load.
 *
 * The same sweep bounds guardrail telemetry (GUARDRAIL_RETENTION_DAYS,
 * default 30, 0 disables). Those rows hold the text that was scanned --
 * real user messages and text fetched from pages we do not control -- so a
 * table that grows forever is a liability that grows forever. Thirty days is
 * long enough to tune a threshold against and short enough that the corpus
 * is never a permanent record of what anyone typed.
 *
 * What goes: an ended, unreferenced event once it is past its retention
 * window — a short one for one-offs (EVENT_ONEOFF_RETENTION_DAYS, default 1: a
 * concert is dead the morning after, and lingering ones just bloat every
 * client's events payload and get re-scraped and re-rejected by discovery) and
 * a longer one for recurring series (EVENT_RETENTION_DAYS, default 30, 0
 * disables the whole sweep). Unbounded weekly series (farmers markets) never
 * qualify — nextOccurrence keeps rolling them forward. What stays regardless
 * of age: anything a user saved to their calendar or reacted to — deletes
 * cascade into those tables, and reactions feed the taste model, so pruning
 * them would erase user history.
 */
import { pruneChatCheckpoints } from "./checkpointer.js";
import { db } from "./db.js";
import { nextOccurrence } from "./recurrence.js";
import { store } from "./store.js";

const SWEEP_INTERVAL_MS = 12 * 3_600_000;

function retentionDays(): number {
  const raw = Number(process.env.EVENT_RETENTION_DAYS ?? 30);
  return Number.isFinite(raw) && raw >= 0 ? raw : 30;
}

/**
 * How long an ended one-off lingers before it's swept. Kept short: every
 * surface already hides ended events, so the only value left is a brief grace
 * for timezone edges and "what was on last night". Default 1 day; the master
 * EVENT_RETENTION_DAYS=0 switch still disables the whole sweep.
 */
function oneOffRetentionDays(): number {
  const raw = Number(process.env.EVENT_ONEOFF_RETENTION_DAYS ?? 1);
  return Number.isFinite(raw) && raw >= 0 ? raw : 1;
}

/** Ids of events some user has saved or reacted to — never pruned. */
async function referencedIds(): Promise<Set<string>> {
  const [cal, reactions] = await Promise.all([
    db.from("calendar_entries").select("event_id").throwOnError(),
    db.from("event_reactions").select("event_id").throwOnError(),
  ]);
  return new Set([
    ...cal.data.map((r) => r.event_id),
    ...reactions.data.map((r) => r.event_id),
  ]);
}

/** One pass: delete long-ended, unreferenced events. Returns count removed. */
export async function pruneEndedEvents(): Promise<number> {
  const days = retentionDays();
  if (days === 0) return 0; // master kill switch
  const oneOffDays = oneOffRetentionDays();
  const now = new Date();
  const seriesCutoff = now.getTime() - days * 86_400_000;
  const oneOffCutoff = now.getTime() - oneOffDays * 86_400_000;
  const { tz } = await store.settings();

  const events = await store.events();
  const keep = await referencedIds();
  const stale = events.filter((e) => {
    if (keep.has(e.id)) return false;
    // For one-offs this is the event's own end; for bounded series the final
    // occurrence; unbounded series always report a current-or-future end.
    const end = Date.parse(nextOccurrence(e, now, tz).end);
    if (!Number.isFinite(end)) return false;
    // One-offs retire fast; recurring series keep the longer window so a brief
    // gap between occurrences can never delete a still-active series.
    return end < (e.recurrence ? seriesCutoff : oneOffCutoff);
  });
  if (!stale.length) return 0;

  const removed = await store.deleteEvents(stale.map((e) => e.id));
  console.log(
    `[grapevine] retention: pruned ${removed} event${removed === 1 ? "" : "s"} ` +
      `(one-offs >${oneOffDays}d, series >${days}d ended; ` +
      `${stale.slice(0, 3).map((e) => e.id).join(", ")}${stale.length > 3 ? ", …" : ""})`,
  );
  return removed;
}

/**
 * How long a recorded guardrail decision is kept. Independent of the event
 * window: they bound different things, and someone shortening one almost never
 * means the other.
 */
function guardrailRetentionDays(): number {
  const raw = Number(process.env.GUARDRAIL_RETENTION_DAYS ?? 30);
  return Number.isFinite(raw) && raw >= 0 ? raw : 30;
}

/** One pass over the telemetry table. Returns how many rows went. */
export async function pruneGuardrailScans(): Promise<number> {
  const days = guardrailRetentionDays();
  if (days === 0) return 0;
  const cutoff = new Date(Date.now() - days * 86_400_000);
  const removed = await store.pruneGuardrailScans(cutoff);
  if (removed) {
    console.log(`[grapevine] retention: pruned ${removed} guardrail scan${removed === 1 ? "" : "s"} older than ${days}d`);
  }
  return removed;
}

/**
 * LangGraph checkpoints are runtime state, not the record (chat_messages is);
 * the saver already prunes each thread to its newest dozen, so this only has
 * to catch threads nobody ever revisits.
 */
function checkpointRetentionDays(): number {
  const raw = Number(process.env.CHAT_CHECKPOINT_RETENTION_DAYS ?? 30);
  return Number.isFinite(raw) && raw >= 0 ? raw : 30;
}

/** One pass over the checkpoint tables. Returns how many checkpoints went. */
export async function pruneOldCheckpoints(): Promise<number> {
  const days = checkpointRetentionDays();
  if (days === 0) return 0;
  const removed = await pruneChatCheckpoints(new Date(Date.now() - days * 86_400_000));
  if (removed) {
    console.log(`[grapevine] retention: pruned ${removed} chat checkpoint${removed === 1 ? "" : "s"} older than ${days}d`);
  }
  return removed;
}

/**
 * Boot pass + a slow interval; failures log and retry next cycle.
 *
 * The sweeps are independent: EVENT_RETENTION_DAYS=0 disables event
 * pruning, and guardrail telemetry still has to be bounded, because a table
 * of everything anyone typed is not something to leave running because an
 * unrelated switch was flipped.
 */
export function startRetentionSweep(): void {
  const events = retentionDays() > 0;
  const scans = guardrailRetentionDays() > 0;
  const checkpoints = checkpointRetentionDays() > 0;
  if (!events) console.log("[grapevine] retention: events disabled (EVENT_RETENTION_DAYS=0)");
  if (!scans) console.log("[grapevine] retention: guardrail scans disabled (GUARDRAIL_RETENTION_DAYS=0)");
  if (!checkpoints) console.log("[grapevine] retention: chat checkpoints disabled (CHAT_CHECKPOINT_RETENTION_DAYS=0)");
  if (!events && !scans && !checkpoints) return;

  const run = async () => {
    if (events) {
      await pruneEndedEvents().catch((err) =>
        console.log(`[grapevine] retention error: ${String(err).slice(0, 200)}`),
      );
    }
    if (scans) {
      await pruneGuardrailScans().catch((err) =>
        console.log(`[grapevine] guardrail retention error: ${String(err).slice(0, 200)}`),
      );
    }
    if (checkpoints) {
      await pruneOldCheckpoints().catch((err) =>
        console.log(`[grapevine] checkpoint retention error: ${String(err).slice(0, 200)}`),
      );
    }
  };
  void run();
  setInterval(() => void run(), SWEEP_INTERVAL_MS);
}
