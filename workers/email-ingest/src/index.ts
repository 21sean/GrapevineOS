/**
 * Cloudflare Email Worker: the inbox IS the pipeline.
 *
 * Catch-all routing means dostuff@example.com, sdtoday@example.com, and so on (whatever domain Email Routing is on)
 * all arrive here without being created first; the To: address carries the
 * source attribution for free.
 *
 * Each email is inserted into the Supabase raw_emails table (the durable
 * ledger). If INGEST_URL is set, the worker then pings the server so it
 * processes the new row immediately (event-driven, no polling). If the
 * insert fails, the raw copy goes to the RAW_EMAILS KV namespace as a dead
 * letter so nothing is lost. Recover it with `wrangler kv key list/get`
 * and re-ingest once Supabase is reachable again. If BOTH stores fail, the
 * handler throws so Cloudflare answers the sender with a transient failure
 * and the message is redelivered instead of silently dropped.
 *
 * An hourly cron drains that dead letter back into Supabase once it is
 * reachable again, so the KV copy is a delay rather than a 30-day expiry.
 *
 * The logic lives in lib.ts: workerd requires every entry-point export to
 * be a handler, so this module exports nothing but the handlers themselves.
 */
import { drainDeadLetters, handleEmail, type Env } from "./lib";

export type { Env };

export default {
  email: handleEmail,
  scheduled: (_event, env, ctx) => {
    ctx.waitUntil(drainDeadLetters(env));
  },
} satisfies ExportedHandler<Env>;
