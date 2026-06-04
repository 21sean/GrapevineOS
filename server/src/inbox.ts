/**
 * Inbox ingestion over Postgres (replaces the Cloudflare KV poll).
 *
 * The email worker inserts every inbound newsletter into raw_emails; this
 * poller picks up unprocessed rows, runs them through the same Ollama
 * pipeline as manual pastes, and stamps processed_at + the ingest log id
 * onto the row. One cheap indexed query per tick — no KV list-op budget,
 * no Cloudflare API token, and kv-processed.json is gone: the row itself
 * is the ledger.
 *
 * A row that fails (Ollama down, bad extraction) keeps processed_at null
 * and records the error, so it retries next tick and the admin inbox can
 * show what's stuck — same retry semantics the KV poller had.
 */
import { db } from "./db.js";
import type { Tables } from "./db-types.js";
import { extractEvents } from "./ingest.js";
import { store } from "./store.js";

const DEFAULT_POLL_SECONDS = 60;

function pollIntervalMs(): number | null {
  if (/^(0|false|no)$/i.test(process.env.INBOX_POLL ?? "")) return null;
  const seconds = Number(process.env.INBOX_POLL_SECONDS ?? DEFAULT_POLL_SECONDS);
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
  const added = await store.addEvents(events);
  const ingest = await store.logIngest({
    source,
    kind: "email",
    subject: row.subject || undefined,
    extracted: events.length,
    added: added.length,
    events: added.map((e) => ({ id: e.id, title: e.title, start: e.start })),
  });
  await db
    .from("raw_emails")
    .update({ processed_at: new Date().toISOString(), ingest_id: ingest.id, error: null })
    .eq("id", row.id)
    .throwOnError();
  return { extracted: events.length, added: added.length };
}

let running = false;

async function tick(): Promise<void> {
  if (running) return; // don't overlap a slow LLM pass with the next tick
  running = true;
  try {
    const { data: pending } = await db
      .from("raw_emails")
      .select("*")
      .is("processed_at", null)
      .order("received_at", { ascending: true })
      .limit(20)
      .throwOnError();
    for (const row of pending) {
      try {
        const r = await processEmail(row);
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
  } catch (err) {
    console.log(`[grapevine] inbox poll error: ${String(err).slice(0, 200)}`);
  } finally {
    running = false;
  }
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

/** Starts the poll loop unless INBOX_POLL=0. */
export function startInboxPoll(): void {
  const intervalMs = pollIntervalMs();
  if (!intervalMs) {
    console.log("[grapevine] inbox: polling disabled (INBOX_POLL=0)");
    return;
  }
  console.log(`[grapevine] inbox: polling raw_emails every ${intervalMs / 1000}s`);
  void tick();
  setInterval(() => void tick(), intervalMs);
}
