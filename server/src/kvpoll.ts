/**
 * KV-pull ingestion (no tunnel needed).
 *
 * The Cloudflare Email Worker writes every inbound newsletter to a KV
 * namespace. This poller reads that namespace over the Cloudflare REST API,
 * runs each new email through the same Ollama pipeline as manual pastes, and
 * remembers which keys it has processed so nothing is ingested twice.
 *
 * Why pull instead of push: a local dev server has no stable public URL, and
 * cloudflared quick-tunnels change address on every restart. Polling KV needs
 * no inbound connectivity, survives restarts, and catches up automatically
 * after the laptop sleeps. The worker's 30-day KV TTL is the backup — we never
 * delete, we just track processed keys locally and prune ones KV has expired.
 */
import fs from "node:fs";
import path from "node:path";
import { store } from "./store.js";
import { extractEvents } from "./ingest.js";

const DATA_DIR = path.resolve(import.meta.dirname, "../data");
const PROCESSED_FILE = path.join(DATA_DIR, "kv-processed.json");

interface Config {
  token: string;
  accountId: string;
  namespaceId: string;
  intervalMs: number;
}

function config(): Config | null {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const namespaceId = process.env.KV_NAMESPACE_ID;
  const disabled = /^(0|false|no)$/i.test(process.env.KV_POLL ?? "");
  if (disabled || !token || !accountId || !namespaceId) return null;
  const seconds = Number(process.env.KV_POLL_SECONDS ?? 60);
  return {
    token,
    accountId,
    namespaceId,
    intervalMs: Math.max(15, seconds) * 1000,
  };
}

function kvUrl(c: Config, suffix: string): string {
  return (
    `https://api.cloudflare.com/client/v4/accounts/${c.accountId}` +
    `/storage/kv/namespaces/${c.namespaceId}${suffix}`
  );
}

function loadProcessed(): Set<string> {
  try {
    return new Set(JSON.parse(fs.readFileSync(PROCESSED_FILE, "utf8")) as string[]);
  } catch {
    return new Set();
  }
}

function saveProcessed(keys: Set<string>) {
  const tmp = PROCESSED_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify([...keys]));
  fs.renameSync(tmp, PROCESSED_FILE);
}

/** List every key in the namespace, following pagination cursors. */
async function listKeys(c: Config): Promise<string[]> {
  const names: string[] = [];
  let cursor = "";
  do {
    const url = kvUrl(c, `/keys?limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${c.token}` },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`kv list ${res.status}: ${body.slice(0, 160)}`);
    }
    const body = (await res.json()) as {
      result: { name: string }[];
      result_info?: { cursor?: string };
    };
    for (const k of body.result ?? []) names.push(k.name);
    cursor = body.result_info?.cursor ?? "";
  } while (cursor);
  return names;
}

async function readEmail(c: Config, key: string): Promise<{
  to?: string;
  subject?: string;
  text?: string;
} | null> {
  const res = await fetch(kvUrl(c, `/values/${encodeURIComponent(key)}`), {
    headers: { Authorization: `Bearer ${c.token}` },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) return null;
  try {
    return JSON.parse(await res.text());
  } catch {
    return null;
  }
}

async function ingestOne(c: Config, key: string): Promise<void> {
  const email = await readEmail(c, key);
  if (!email?.text) return;
  const source = String(email.to ?? "").split("@")[0] || "inbound";
  const events = await extractEvents({
    text: `Subject: ${email.subject ?? ""}\n\n${email.text}`,
    source,
  });
  const added = store.addEvents(events);
  store.logIngest({
    source,
    kind: "email",
    subject: email.subject || undefined,
    extracted: events.length,
    added: added.length,
    events: added.map((e) => ({ id: e.id, title: e.title, start: e.start })),
  });
  console.log(
    `[grapevine] kv-poll: ${source} “${email.subject ?? "(no subject)"}” → ` +
      `${events.length} extracted, ${added.length} new`,
  );
}

let running = false;

async function tick(c: Config): Promise<void> {
  if (running) return; // don't overlap a slow LLM pass with the next tick
  running = true;
  try {
    const keys = await listKeys(c);
    const present = new Set(keys);
    const processed = loadProcessed();

    // prune keys KV has since expired so the ledger doesn't grow unbounded
    let pruned = false;
    for (const k of processed) {
      if (!present.has(k)) {
        processed.delete(k);
        pruned = true;
      }
    }

    const fresh = keys.filter((k) => !processed.has(k));
    for (const key of fresh) {
      try {
        await ingestOne(c, key);
      } catch (err) {
        // leave the key unprocessed so it retries next tick
        console.log(`[grapevine] kv-poll: ${key} failed — ${String(err).slice(0, 160)}`);
        continue;
      }
      processed.add(key);
      saveProcessed(processed); // persist per-item: a crash never reprocesses
    }
    if (pruned && !fresh.length) saveProcessed(processed);
  } catch (err) {
    console.log(`[grapevine] kv-poll error: ${String(err).slice(0, 200)}`);
  } finally {
    running = false;
  }
}

/** Starts the KV poll loop if Cloudflare + namespace config is present. */
export function startKvPoll(): void {
  const c = config();
  if (!c) {
    console.log(
      "[grapevine] kv-poll: idle (set CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, KV_NAMESPACE_ID to enable)",
    );
    return;
  }
  console.log(
    `[grapevine] kv-poll: watching namespace ${c.namespaceId.slice(0, 8)}… every ${c.intervalMs / 1000}s`,
  );
  void tick(c);
  setInterval(() => void tick(c), c.intervalMs);
}
