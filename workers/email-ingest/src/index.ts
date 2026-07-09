/**
 * Cloudflare Email Worker: the inbox IS the pipeline.
 *
 * Catch-all routing means dostuff@sean.ventures, sdtoday@sean.ventures, etc.
 * all arrive here without being created first — the To: address carries the
 * source attribution for free.
 *
 * Each email is inserted into the Supabase raw_emails table (the durable
 * ledger). If INGEST_URL is set, the worker then pings the server so it
 * processes the new row immediately (event-driven — no polling). If the
 * insert fails, the raw copy goes to the RAW_EMAILS KV namespace as a dead
 * letter so nothing is lost — reprocess it from Admin → Ingest once Supabase
 * is reachable again.
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

/** Insert into raw_emails via PostgREST. The unique email_key makes worker
 * retries/redeliveries idempotent (duplicates are silently ignored). */
async function insertRawEmail(env: Env, key: string, p: EmailPayload): Promise<void> {
  if (!env.SUPABASE_URL || !env.SUPABASE_SECRET_KEY) {
    throw new Error("SUPABASE_URL / SUPABASE_SECRET_KEY not configured");
  }
  const res = await fetch(
    `${env.SUPABASE_URL}/rest/v1/raw_emails?on_conflict=email_key`,
    {
      method: "POST",
      headers: {
        apikey: env.SUPABASE_SECRET_KEY,
        Authorization: `Bearer ${env.SUPABASE_SECRET_KEY}`,
        "Content-Type": "application/json",
        Prefer: "resolution=ignore-duplicates",
      },
      body: JSON.stringify([
        {
          email_key: key,
          source: p.to.split("@")[0] || "inbound",
          to_addr: p.to,
          from_addr: p.from,
          subject: p.subject,
          body_text: p.text,
          received_at: p.receivedAt,
        },
      ]),
    },
  );
  if (!res.ok) {
    throw new Error(`raw_emails insert ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
}

export default {
  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    const parsed = await PostalMime.parse(message.raw);

    const to = message.to ?? parsed.to?.[0]?.address ?? "unknown@unknown";
    const payload: EmailPayload = {
      to,
      from: message.from ?? parsed.from?.address ?? "",
      subject: parsed.subject ?? "",
      // prefer plaintext; fall back to crudely stripped HTML
      text:
        parsed.text ??
        (parsed.html
          ? parsed.html
              .replace(/<style[\s\S]*?<\/style>/gi, "")
              .replace(/<[^>]+>/g, " ")
              .replace(/\s+/g, " ")
          : ""),
      receivedAt: new Date().toISOString(),
    };
    const key = `${payload.receivedAt}_${to.split("@")[0]}`;

    try {
      await insertRawEmail(env, key, payload);
    } catch (err) {
      // Dead letter: keep the raw copy in KV (30-day TTL) so the email
      // survives a Supabase outage or misconfiguration.
      console.log(`supabase insert failed (${err}): dead-lettering ${key} to KV`);
      await env.RAW_EMAILS.put(key, JSON.stringify(payload), {
        expirationTtl: 60 * 60 * 24 * 30,
      });
    }

    // Optional push mode (tunnel/deploy): only when INGEST_URL is configured.
    if (pushEnabled(env.INGEST_URL)) {
      try {
        const res = await fetch(env.INGEST_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Ingest-Key": env.INGEST_KEY ?? "",
          },
          body: JSON.stringify(payload),
        });
        if (!res.ok) {
          console.log(`ingest endpoint ${res.status}: raw copy stored as ${key}`);
        }
      } catch (err) {
        console.log(`ingest endpoint unreachable (${err}): raw copy stored as ${key}`);
      }
    }
  },
} satisfies ExportedHandler<Env>;
