/**
 * Cloudflare Email Worker: the inbox IS the pipeline.
 *
 * Catch-all routing means dostuff@sean.ventures, sdtoday@sean.ventures, etc.
 * all arrive here without being created first — the To: address carries the
 * source attribution for free.
 */
import PostalMime from "postal-mime";

export interface Env {
  RAW_EMAILS: KVNamespace;
  // Optional. Leave empty for pull mode (the local server polls KV). Set to a
  // tunnel/deploy URL to also push each email straight to /api/ingest/inbound.
  INGEST_URL?: string;
  INGEST_KEY?: string;
}

function pushEnabled(url?: string): url is string {
  return !!url && /^https?:\/\//.test(url) && !url.includes("REPLACE");
}

export default {
  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    const parsed = await PostalMime.parse(message.raw);

    const to = message.to ?? parsed.to?.[0]?.address ?? "unknown@unknown";
    const payload = {
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

    // KV is the pipeline: the local server polls this namespace and ingests
    // each new key. The 30-day TTL doubles as a re-runnable backup.
    const key = `${payload.receivedAt}_${to.split("@")[0]}`;
    await env.RAW_EMAILS.put(key, JSON.stringify(payload), {
      expirationTtl: 60 * 60 * 24 * 30,
    });

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
          console.log(`ingest endpoint ${res.status}: kept raw copy at ${key}`);
        }
      } catch (err) {
        console.log(`ingest endpoint unreachable (${err}): kept raw copy at ${key}`);
      }
    }
  },
} satisfies ExportedHandler<Env>;
