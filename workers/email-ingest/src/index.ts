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
 * letter so nothing is lost — recover it with `wrangler kv key list/get`
 * and re-ingest once Supabase is reachable again. If BOTH stores fail, the
 * handler throws so Cloudflare answers the sender with a transient failure
 * and the message is redelivered instead of silently dropped.
 *
 * The logic lives in lib.ts — workerd requires every entry-point export to
 * be a handler, so this module exports nothing but the handler itself.
 */
import { handleEmail, type Env } from "./lib";

export type { Env };

export default {
  email: handleEmail,
} satisfies ExportedHandler<Env>;
