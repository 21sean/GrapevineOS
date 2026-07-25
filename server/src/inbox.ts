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
 * A row that fails (Ollama down, bad extraction) keeps processed_at null and
 * records the error, so the next kick (or the next inbound email) retries it
 * and the admin inbox can show what's stuck — same retry semantics as before.
 */
import { db } from "./db.js";
import type { Tables } from "./db-types.js";
import { extractEvents } from "./ingest.js";
import { commitIngest } from "./pipeline.js";

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
  await db
    .from("raw_emails")
    .update({ processed_at: new Date().toISOString(), ingest_id: ingest.id, error: null })
    .eq("id", row.id)
    .throwOnError();
  return { extracted: events.length, added: added.length };
}

let running = false;
let rerun = false;

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
      const { data: pending } = await db
        .from("raw_emails")
        .select("*")
        .is("processed_at", null)
        .order("received_at", { ascending: true })
        .limit(BATCH)
        .throwOnError();
      let processed = 0;
      for (const row of pending) {
        try {
          const r = await processEmail(row);
          processed++;
          console.log(
            `[grapevine] inbox: ${row.source} “${row.subject || "(no subject)"}” → ` +
              `${r.extracted} extracted, ${r.added} new`,
          );
        } catch (err) {
          const message = String(err).slice(0, 300);
          console.log(`[grapevine] inbox: ${row.email_key} failed — ${message}`);
          await db.from("raw_emails").update({ error: message }).eq("id", row.id);
        }
      }
      // A full batch may not be the whole backlog — drain the rest now, but
      // only if we made progress. A full batch that all failed keeps its rows
      // unprocessed, so looping would just re-select and re-fail them forever;
      // leave those for the next kick/startup pass to retry.
      if (pending.length === BATCH && processed > 0) rerun = true;
    } while (rerun);
  } catch (err) {
    console.log(`[grapevine] inbox error: ${String(err).slice(0, 200)}`);
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

export interface InboxEmail {
  key: string;
  source: string;
  from: string;
  subject: string;
  receivedAt: string;
  chars: number;
  processed: boolean;
  error?: string;
}

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
 * before — dedupe in addEvents keeps reruns harmless.
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
  return processEmail(row);
}

/**
 * Drain any backlog at boot (mail that arrived while the server was down, or
 * dead letters that were reprocessed into the table), then stay event-driven:
 * kickInbox() runs on each inbound email. Set INBOX_POLL_SECONDS to also poll
 * on a timer where the worker can't reach this server.
 */
export function startInboxPoll(): void {
  void tick();
  const intervalMs = pollIntervalMs();
  if (!intervalMs) {
    console.log("[grapevine] inbox: event-driven (processes on inbound email; no polling)");
    return;
  }
  console.log(`[grapevine] inbox: polling raw_emails every ${intervalMs / 1000}s (safety net)`);
  setInterval(() => void tick(), intervalMs);
}
