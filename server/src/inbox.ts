/**
 * Inbox ingestion over Postgres (replaces the Cloudflare KV poll).
 *
 * The email worker inserts every inbound newsletter into raw_emails, then
 * pings /api/ingest/inbound; that calls kickInbox() here, which picks up the
 * unprocessed rows, runs them through the same Ollama pipeline as manual
 * pastes, and stamps processed_at + the ingest log id onto the row. The row
 * itself is the ledger — no KV list-op budget, no Cloudflare API token.
 *
 * Event-driven by default: nothing runs on a timer, so the local model isn't
 * woken (and swapped into VRAM) every minute just to find an empty queue.
 * A backlog pass runs once at boot to drain anything that arrived while the
 * server was down, and INBOX_POLL_SECONDS re-enables interval polling as a
 * safety net for setups where the worker can't reach this server.
 *
 * Two things can deliver that "wake up" event, and both are wired:
 *
 *   1. Supabase Realtime (default, no configuration). The server holds one
 *      OUTBOUND websocket to Supabase and is told about each raw_emails
 *      insert. Outbound means it works from a laptop behind NAT with nothing
 *      exposed to the internet — which is why the INGEST_URL ping alone was
 *      never enough in practice and the pipeline kept falling back to the
 *      timer.
 *   2. The worker's /api/ingest/inbound ping, for deployments where this
 *      server IS reachable (a tunnel or a real host).
 *
 * Either one just calls kickInbox(); duplicate wakes coalesce into one pass,
 * so running both costs nothing.
 *
 * A row that fails (Ollama down, bad extraction) keeps processed_at null and
 * records the error, so the next kick (or the next inbound email) retries it
 * and the admin inbox can show what's stuck — same retry semantics as before.
 */
import type { RealtimeChannel } from "@supabase/supabase-js";
import { MAX_ATTEMPTS } from "./budget.js";
import { db } from "./db.js";
import { startLoop } from "./lifecycle.js";
import type { Tables } from "./db-types.js";
import type { InboxEmail } from "./types.js";
import { extractEvents } from "./ingest.js";
import { commitIngest } from "./pipeline.js";
import { logger } from "./log.js";

const log = logger("inbox");

/** Rows drained per query; a full batch re-runs so one kick clears a backlog. */
const BATCH = 20;

/** Interval polling is opt-in (event-driven by default): one flag,
 * INBOX_POLL_SECONDS — unset/0 means no timer, a positive value polls. */
function pollIntervalMs(): number | null {
  const raw = process.env.INBOX_POLL_SECONDS;
  if (!raw) return null;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return Math.max(15, seconds) * 1000;
}

type RawEmail = Tables<"raw_emails">;

/** Extract + log one email, then mark its row processed. */
async function processEmail(row: RawEmail): Promise<{ extracted: number; added: number }> {
  const source = row.source || "inbound";
  const events = await extractEvents({
    text: `Subject: ${row.subject}\n\n${row.body_text}`,
    source,
  });
  const { added, ingest } = await commitIngest({
    events,
    source,
    kind: "email",
    subject: row.subject || undefined,
  });
  // attempts resets on success: the budget counts consecutive failures, so a
  // row that finally succeeds after two flaky passes starts clean if it is
  // ever reprocessed later.
  await db
    .from("raw_emails")
    .update({
      processed_at: new Date().toISOString(),
      ingest_id: ingest.id,
      error: null,
      ...(hasAttempts && { attempts: 0 }),
    })
    .eq("id", row.id)
    .throwOnError();
  return { extracted: events.length, added: added.length };
}

let running = false;
let rerun = false;

/**
 * Realtime health, so a silently dead subscription can't masquerade as a
 * working one.
 *
 * subscribe() reports SUBSCRIBED whether or not raw_emails is actually a
 * member of the supabase_realtime publication — if the migration was never
 * applied, the channel opens cleanly and then simply never fires. The only
 * honest evidence that it works is a delivery, so: if a poll ever finds
 * unprocessed mail while we believe we are subscribed and have never been
 * told about a single insert, say so once. Silence is the failure here.
 */
let subscribed = false;
let realtimeDeliveries = 0;
let warnedRealtimeSilent = false;

/**
 * Whether raw_emails.attempts exists yet.
 *
 * The attempt budget needs a column that arrives with a migration, and a
 * deploy that lands before its migration must not take the inbox down —
 * failing to extract mail is a worse outcome than retrying a poison row a few
 * extra times. So the filter is applied optimistically, and a missing column
 * (PostgREST 42703) downgrades to the old unbounded behaviour with one clear
 * line about how to fix it. Once the migration runs, the next process start
 * picks the budget back up.
 */
let hasAttempts = true;
let warnedNoAttempts = false;

/** Pending rows, with the attempt budget applied when the schema supports it. */
async function selectPending(): Promise<RawEmail[]> {
  const base = () => db.from("raw_emails").select("*").is("processed_at", null);
  const order = (q: ReturnType<typeof base>) =>
    q.order("received_at", { ascending: true }).limit(BATCH);

  if (hasAttempts) {
    const { data, error } = await order(base().lt("attempts", MAX_ATTEMPTS));
    if (!error) return data as RawEmail[];
    if (error.code !== "42703") throw error;
    hasAttempts = false;
    if (!warnedNoAttempts) {
      warnedNoAttempts = true;
      log.info(
        "inbox: raw_emails.attempts is missing, so failed emails retry without a " +
          "budget. Apply supabase/migrations/20260731170000_raw_emails_attempts.sql.",
      );
    }
  }
  const { data } = await order(base()).throwOnError();
  return data as RawEmail[];
}

async function tick(): Promise<void> {
  // A kick that lands mid-pass sets rerun instead of overlapping a slow LLM
  // pass — the in-flight pass loops once more so nothing is left stranded.
  if (running) {
    rerun = true;
    return;
  }
  running = true;
  try {
    do {
      rerun = false;
      const pending = await selectPending();
      if (pending.length && subscribed && realtimeDeliveries === 0 && !warnedRealtimeSilent) {
        warnedRealtimeSilent = true;
        log.info(
          "inbox: found unprocessed mail that realtime never announced — " +
            "the subscription is open but silent. Apply " +
            "supabase/migrations/20260731191301_raw_emails_realtime.sql " +
            "(raw_emails must be in the supabase_realtime publication).",
        );
      }
      let processed = 0;
      for (const row of pending) {
        try {
          const r = await processEmail(row);
          processed++;
          log.info(
            `inbox: ${row.source} “${row.subject || "(no subject)"}” → ` +
              `${r.extracted} extracted, ${r.added} new`,
          );
        } catch (err) {
          const message = String(err).slice(0, 300);
          const attempts = (row.attempts ?? 0) + 1;
          const exhausted = hasAttempts && attempts >= MAX_ATTEMPTS;
          log.info(
            `inbox: ${row.email_key} failed` +
              (hasAttempts
                ? ` (attempt ${attempts}/${MAX_ATTEMPTS}` +
                  `${exhausted ? ", giving up — reprocess by hand to retry" : ""})`
                : "") +
              ` — ${message}`,
          );
          await db
            .from("raw_emails")
            .update({ error: message, ...(hasAttempts && { attempts }) })
            .eq("id", row.id);
        }
      }
      // A full batch may not be the whole backlog — drain the rest now, but
      // only if we made progress. A full batch that all failed keeps its rows
      // unprocessed, so looping would just re-select and re-fail them forever;
      // leave those for the next kick/startup pass to retry.
      if (pending.length === BATCH && processed > 0) rerun = true;
    } while (rerun);
  } catch (err) {
    log.info(`inbox error: ${String(err).slice(0, 200)}`);
  } finally {
    running = false;
  }
}

/**
 * Process pending inbox rows now. The email worker calls this (via
 * /api/ingest/inbound) right after inserting an email, so extraction starts on
 * arrival instead of on a timer. Bursts coalesce into one pass.
 */
export function kickInbox(): void {
  void tick();
}

// ---------- admin inbox (views over the same table) ----------

export type { InboxEmail };

/** Newest emails with their pipeline status. char_count is a generated
 * column, so listings never ship whole newsletter bodies. */
export async function listInbox(limit = 30): Promise<{
  configured: boolean;
  emails: InboxEmail[];
}> {
  const { data: rows } = await db
    .from("raw_emails")
    .select("email_key, source, from_addr, subject, received_at, char_count, processed_at, error")
    .order("received_at", { ascending: false })
    .limit(limit)
    .throwOnError();
  return {
    configured: true,
    emails: rows.map((r) => ({
      key: r.email_key,
      source: r.source,
      from: r.from_addr,
      subject: r.subject,
      receivedAt: r.received_at,
      chars: r.char_count ?? 0,
      processed: !!r.processed_at,
      ...(r.error && { error: r.error }),
    })),
  };
}

/**
 * Re-run one email through extraction, whether or not it was processed
 * before — dedupe in addEvents keeps reruns harmless. This is also the way
 * back for a row that exhausted its attempt budget: an explicit human retry
 * clears the count, so the automatic pipeline will pick it up again if this
 * run fails for a new reason.
 */
export async function reprocessInbox(key: string): Promise<{
  extracted: number;
  added: number;
}> {
  const { data: row } = await db
    .from("raw_emails")
    .select("*")
    .eq("email_key", key)
    .maybeSingle()
    .throwOnError();
  if (!row?.body_text) throw new Error("email not found (purged after 30 days?)");
  if (hasAttempts) await db.from("raw_emails").update({ attempts: 0 }).eq("id", row.id);
  return processEmail({ ...row, attempts: 0 });
}

/**
 * Subscribe to raw_emails inserts and kick a pass on each one.
 *
 * The payload is deliberately ignored — tick() re-reads the pending rows
 * anyway, so a dropped or coalesced notification costs latency, never an
 * email. That is also why a failed subscription is only a warning: the boot
 * pass plus INBOX_POLL_SECONDS still drain the queue.
 */
let channel: RealtimeChannel | null = null;

/** Unsubscribe the realtime channel; the shutdown hook calls this. */
export async function stopInbox(): Promise<void> {
  const open = channel;
  channel = null;
  await open?.unsubscribe();
}

function startRealtime(): void {
  channel = db.channel("raw_emails_inserts")
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "raw_emails" }, () => {
      realtimeDeliveries++;
      kickInbox();
    })
    .subscribe((status) => {
      if (status === "SUBSCRIBED") {
        subscribed = true;
        log.info("inbox: realtime subscribed");
      } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        subscribed = false;
        log.info(
          `inbox: realtime unavailable (${status}) — ` +
            "falling back to the boot pass + INBOX_POLL_SECONDS.",
        );
      }
    });
}

/**
 * Drain any backlog at boot (mail that arrived while the server was down, or
 * dead letters that were reprocessed into the table), then stay event-driven:
 * kickInbox() runs on each inbound email, woken by Realtime and/or the
 * worker's ping. INBOX_POLL_SECONDS adds a timer on top as a safety net.
 */
export function startInboxPoll(): void {
  void tick();
  startRealtime();
  const intervalMs = pollIntervalMs() ?? 0;
  if (intervalMs) log.info(`also polling raw_emails every ${intervalMs / 1000}s (safety net)`);
  startLoop({
    name: "inbox poll",
    enabled: intervalMs > 0,
    disabledReason: "set INBOX_POLL_SECONDS for a safety net",
    intervalMs,
    run: tick,
  });
}

/**
 * The domain Cloudflare Email Routing's catch-all delivers from. Deployment
 * config rather than a stored setting, and defaulted to the RFC 2606 example
 * domain so a fresh clone never shows anyone else's addresses.
 */
export function inboxDomain(): string {
  return (process.env.INBOX_DOMAIN ?? "").trim().toLowerCase() || "example.com";
}
