/**
 * Everything the email handler uses, in a module of its own: workerd rejects
 * entry-point exports that aren't handlers ("Incorrect type for map entry"),
 * so the constants and helpers the tests import live here and index.ts
 * exports only the handler.
 */
import PostalMime from "postal-mime";

export interface Env {
  RAW_EMAILS: KVNamespace;
  // Supabase Data API — SUPABASE_URL is a plain var in wrangler.toml;
  // SUPABASE_SECRET_KEY is a secret: npx wrangler secret put SUPABASE_SECRET_KEY
  SUPABASE_URL?: string;
  SUPABASE_SECRET_KEY?: string;
  // Optional. Set to a tunnel/deploy URL to also push each email straight to
  // /api/ingest/inbound for instant processing.
  INGEST_URL?: string;
  INGEST_KEY?: string;
}

/** Messages above this skip MIME parsing (headers only) so a 20 MB
 * attachment bomb can't blow the Workers CPU budget; newsletters are <1 MB. */
export const MAX_PARSE_BYTES = 5 * 1024 * 1024;

/** Bodies are capped before insert — larger than any real newsletter, small
 * enough that one pathological email can't bloat the table or a KV value. */
export const MAX_BODY_CHARS = 200_000;

const MAX_SUBJECT_CHARS = 500;
const SUPABASE_TIMEOUT_MS = 10_000;
const PING_TIMEOUT_MS = 10_000;
const DEAD_LETTER_TTL_SECONDS = 60 * 60 * 24 * 30;
export const RETRY_DELAY_MS = 500;

type Parsed = Awaited<ReturnType<typeof PostalMime.parse>>;

function pushEnabled(url?: string): url is string {
  return !!url && /^https?:\/\//.test(url) && !url.includes("REPLACE");
}

interface EmailPayload {
  to: string;
  from: string;
  subject: string;
  text: string;
  receivedAt: string;
}

/**
 * The To: local part becomes the source slug, and the server auto-registers
 * it into sources.id, which is check-constrained to ^[a-z0-9][a-z0-9_-]*$ —
 * an unnormalized "John.Doe" would fail that insert on every retry. So:
 * lowercase, drop any +tag, map disallowed characters to "-", and fall back
 * to "inbound" when nothing survives.
 */
export function sourceSlug(to: string): string {
  const local = to.split("@")[0] ?? "";
  const slug = local
    .toLowerCase()
    .split("+")[0]!
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/-+$/, "");
  return slug || "inbound";
}

function truncate(text: string, cap: number): string {
  if (text.length <= cap) return text;
  return `${text.slice(0, cap)}\n[truncated ${text.length - cap} chars]`;
}

function safeCodePoint(cp: number): string {
  try {
    return String.fromCodePoint(cp);
  } catch {
    return " ";
  }
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  copy: "©",
  reg: "®",
  trade: "™",
  bull: "•",
  middot: "·",
  laquo: "«",
  raquo: "»",
  deg: "°",
  times: "×",
  // Invisible spacers. Marketing templates emit these by the hundred to pad
  // the preview text; decoding them to "" (rather than leaving the literal
  // "&zwnj;" text) is what lets the whitespace collapse below actually
  // collapse them.
  zwnj: "",
  zwj: "",
  shy: "",
  ensp: " ",
  emsp: " ",
  thinsp: " ",
};

/**
 * Zero-width and soft-hyphen characters, which survive whitespace collapsing
 * because they are not whitespace. A single welcome email can carry hundreds
 * of them in a row, and every one is a character charged against the 24k-char
 * extraction window without carrying any meaning.
 */
const INVISIBLES = /[\u200b-\u200d\u2060\ufeff\u00ad]/g;

/** Crude but dependency-free HTML→text for emails with no text/plain part:
 * drop style/script blocks and tags, then decode the entities newsletters
 * actually use so "&amp;" and "&#8212;" don't reach the extraction LLM. */
export function stripHtml(html: string): string {
  return (
    html
      .replace(/<(style|script)[\s\S]*?<\/\1\s*>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => safeCodePoint(parseInt(hex, 16)))
      .replace(/&#(\d+);/g, (_, dec: string) => safeCodePoint(parseInt(dec, 10)))
      .replace(/&([a-z]+);/gi, (m, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? m)
      // After entity decoding, so literal U+200B and a decoded "&zwnj;" are
      // removed by the same pass, and before the whitespace collapse so the
      // spacer runs they were padding actually fold into one space.
      .replace(INVISIBLES, "")
      .replace(/\s+/g, " ")
      .trim()
  );
}

/**
 * Stable per-message key: the RFC 5322 Message-ID when the email carries one,
 * else a content hash. Deriving it from the message (never from the clock)
 * is what makes redeliveries actually idempotent — a retried delivery
 * produces the same email_key and the insert below no-ops on conflict.
 * Bounded well under the 512-byte KV key limit.
 */
export async function emailKey(
  source: string,
  p: EmailPayload,
  messageId?: string,
): Promise<string> {
  const id = messageId?.trim().replace(/[<>]/g, "");
  if (id) return `${source}_${id.slice(0, 180)}`;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${p.to}|${p.from}|${p.subject}|${p.text}`),
  );
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${source}_${hex.slice(0, 32)}`;
}

class InsertError extends Error {
  constructor(
    message: string,
    readonly retriable: boolean,
  ) {
    super(message);
  }
}

async function attemptInsert(env: Env, key: string, p: EmailPayload): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${env.SUPABASE_URL}/rest/v1/raw_emails?on_conflict=email_key`, {
      method: "POST",
      headers: {
        apikey: env.SUPABASE_SECRET_KEY!,
        Authorization: `Bearer ${env.SUPABASE_SECRET_KEY}`,
        "Content-Type": "application/json",
        Prefer: "resolution=ignore-duplicates,return=minimal",
      },
      body: JSON.stringify([
        {
          email_key: key,
          source: sourceSlug(p.to),
          to_addr: p.to,
          from_addr: p.from,
          subject: p.subject,
          body_text: p.text,
          received_at: p.receivedAt,
        },
      ]),
      signal: AbortSignal.timeout(SUPABASE_TIMEOUT_MS),
    });
  } catch (err) {
    // Network error or timeout — transient by nature, worth the one retry.
    throw new InsertError(`raw_emails fetch failed: ${err}`, true);
  }
  if (!res.ok) {
    const retriable = res.status >= 500 || res.status === 429;
    throw new InsertError(
      `raw_emails insert ${res.status}: ${(await res.text()).slice(0, 200)}`,
      retriable,
    );
  }
}

/** Insert into raw_emails via PostgREST. The unique email_key makes worker
 * retries/redeliveries idempotent (duplicates are silently ignored). One
 * retry on transient failures (network, 5xx, 429); config errors like a bad
 * key (401) fail straight through to the dead letter — retrying can't fix
 * those and the KV copy is what preserves the email. */
export async function insertRawEmail(env: Env, key: string, p: EmailPayload): Promise<void> {
  if (!env.SUPABASE_URL || !env.SUPABASE_SECRET_KEY) {
    throw new Error("SUPABASE_URL / SUPABASE_SECRET_KEY not configured");
  }
  try {
    await attemptInsert(env, key, p);
  } catch (err) {
    if (!(err instanceof InsertError) || !err.retriable) throw err;
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    await attemptInsert(env, key, p);
  }
}

/**
 * Build the payload without ever letting a malformed message bounce: parse
 * failures and oversized messages degrade to an envelope/header-only row (the
 * marker body tells the admin inbox what happened) instead of throwing. The
 * envelope To: from the catch-all is authoritative; parsed headers are the
 * fallback, "unknown@unknown" the floor.
 */
async function buildPayload(
  message: ForwardableEmailMessage,
): Promise<{ payload: EmailPayload; messageId?: string }> {
  const headerSubject = message.headers.get("subject") ?? "";
  const headerMessageId = message.headers.get("message-id") ?? undefined;
  const receivedAt = new Date().toISOString();

  let parsed: Parsed | undefined;
  if (message.rawSize <= MAX_PARSE_BYTES) {
    try {
      parsed = await PostalMime.parse(message.raw);
    } catch (err) {
      console.log(`postal-mime parse failed (${err}): storing envelope/header row`);
    }
  }

  const to = (message.to ?? parsed?.to?.[0]?.address ?? "unknown@unknown").toLowerCase();
  const from = message.from ?? parsed?.from?.address ?? "";
  const subject = truncate(parsed?.subject ?? headerSubject, MAX_SUBJECT_CHARS);

  let text: string;
  if (message.rawSize > MAX_PARSE_BYTES) {
    text = `[body skipped: ${message.rawSize}-byte message exceeds the ${MAX_PARSE_BYTES}-byte parse cap]`;
  } else if (!parsed) {
    text = "[body unavailable: message failed MIME parsing]";
  } else {
    // prefer plaintext; fall back to stripped HTML
    text = truncate(
      (parsed.text ?? (parsed.html ? stripHtml(parsed.html) : "")).trim(),
      MAX_BODY_CHARS,
    );
  }

  return {
    payload: { to, from, subject, text, receivedAt },
    messageId: parsed?.messageId ?? headerMessageId,
  };
}

/** The email() handler body — index.ts wraps this as the default export. */
export async function handleEmail(
  message: ForwardableEmailMessage,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  const { payload, messageId } = await buildPayload(message);
  const source = sourceSlug(payload.to);
  const key = await emailKey(source, payload, messageId);

  try {
    await insertRawEmail(env, key, payload);
  } catch (err) {
    // Dead letter: keep the raw copy in KV (30-day TTL) so the email
    // survives a Supabase outage or misconfiguration.
    console.log(`supabase insert failed (${err}): dead-lettering ${key} to KV`);
    try {
      await env.RAW_EMAILS.put(key, JSON.stringify(payload), {
        expirationTtl: DEAD_LETTER_TTL_SECONDS,
      });
    } catch (kvErr) {
      // Both stores down: throw so Cloudflare answers the sender with a
      // transient failure and the message is redelivered later — the
      // message-derived key keeps that redelivery idempotent.
      throw new Error(`insert failed (${err}); dead-letter failed (${kvErr})`, { cause: kvErr });
    }
  }

  // Optional ping (tunnel/deploy): the row is already in Postgres, so this
  // just wakes the server to process it now — no body needed. waitUntil
  // keeps a slow tunnel from delaying the SMTP response.
  if (pushEnabled(env.INGEST_URL)) {
    ctx.waitUntil(pingIngest(env.INGEST_URL, env.INGEST_KEY, key));
  }
}

/**
 * Retry dead letters back into Supabase (the scheduled handler).
 *
 * The dead letter used to be a one-way door: a Supabase outage parked the
 * email in KV with a 30-day TTL and a comment telling a human to run
 * `wrangler kv key get` and re-ingest it by hand. Nobody was ever going to
 * notice in time, so "nothing is lost" quietly expired after a month. This
 * closes the loop — once Supabase is reachable again the parked emails insert
 * themselves and are deleted from KV.
 *
 * Bounded per run so a large backlog can't blow the CPU budget; whatever is
 * left waits for the next tick. Deletion only happens after a successful
 * insert, so a crash mid-drain re-tries rather than loses. The insert is
 * idempotent on email_key, so a redelivered email that already made it in is
 * a no-op followed by a KV cleanup — exactly what we want.
 */
export const DRAIN_LIMIT = 100;

export async function drainDeadLetters(env: Env): Promise<{ drained: number; failed: number }> {
  let drained = 0;
  let failed = 0;
  const listed = await env.RAW_EMAILS.list({ limit: DRAIN_LIMIT });
  for (const entry of listed.keys) {
    const raw = await env.RAW_EMAILS.get(entry.name);
    if (raw === null) continue; // expired between list and get
    let payload: EmailPayload;
    try {
      payload = JSON.parse(raw) as EmailPayload;
    } catch {
      // Not a dead letter we wrote (or corrupt) — leave it for a human rather
      // than deleting data we can't identify.
      console.log(`dead-letter ${entry.name} is not valid JSON: skipping`);
      failed++;
      continue;
    }
    try {
      await insertRawEmail(env, entry.name, payload);
      await env.RAW_EMAILS.delete(entry.name);
      drained++;
    } catch (err) {
      // Still broken. Keep the copy and try again next tick.
      console.log(`dead-letter ${entry.name} still failing: ${err}`);
      failed++;
    }
  }
  if (drained || failed) {
    console.log(`dead-letter drain: ${drained} recovered, ${failed} still parked`);
  }
  // Recovered rows are new work — wake the processor the same way an inbound
  // email does. (Realtime already covers this; the ping is for tunnel setups.)
  if (drained && pushEnabled(env.INGEST_URL)) {
    await pingIngest(env.INGEST_URL, env.INGEST_KEY, `drain:${drained}`);
  }
  return { drained, failed };
}

async function pingIngest(url: string, ingestKey: string | undefined, key: string): Promise<void> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Ingest-Key": ingestKey ?? "",
      },
      body: "{}",
      signal: AbortSignal.timeout(PING_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.log(`ingest endpoint ${res.status}: raw copy stored as ${key}`);
    }
  } catch (err) {
    console.log(`ingest endpoint unreachable (${err}): raw copy stored as ${key}`);
  }
}
