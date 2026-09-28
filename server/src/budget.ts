/**
 * Extraction budgets: every limit the ingestion pipeline spends against,
 * declared once.
 *
 * These used to be implicit and scattered, which is how two of them went
 * wrong: the Ollama call had no timeout at all (a wedged model blocked the
 * inbox forever, and the row it was working on never got its error stamped),
 * and long newsletters were cut with a bare `.slice(0, 24000)` that dropped
 * the tail without saying so. A budget you cannot see is a budget nobody
 * tunes, so they live here, together, and every one is overridable by env.
 *
 * The rule they all follow: exceeding a budget must be LOUD. A truncated
 * document, a skipped row, an abandoned pass: each logs what it gave up.
 * Silent truncation reads as "we processed everything" when we did not.
 */

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/**
 * Characters of source text handed to the model in one call, per provider.
 *
 * Ollama is sized against the 16k-token num_ctx in ollama.ts (roughly 4
 * chars/token, leaving room for the system prompt and the JSON response).
 * Raising it without raising num_ctx just moves the silent truncation inside
 * the model. The subscription CLIs have context windows large enough that a
 * whole newsletter is one call, which is both faster and more accurate: an
 * event mentioned in the intro and dated in the footer stays in one prompt.
 *
 * One env override applies to whichever provider is active; unset, each gets
 * the ceiling that actually fits it.
 */
const CHARS_PER_CHUNK_BY_PROVIDER: Record<string, number> = {
  ollama: 24_000,
  claude: 150_000,
  codex: 150_000,
  gemini: 150_000,
  copilot: 150_000,
};

export function charsPerChunk(provider: string): number {
  const override = process.env.EXTRACT_CHARS_PER_CHUNK;
  if (override) {
    const n = Number(override);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return CHARS_PER_CHUNK_BY_PROVIDER[provider] ?? 24_000;
}

/**
 * Overlap between consecutive chunks. An event described across a chunk
 * boundary would otherwise be half-visible in both and extracted from
 * neither; with overlap it appears whole in the later chunk. Duplicates from
 * the overlap collapse on the event id (title + start), so overlapping costs
 * a little model time and never costs correctness.
 */
export const CHUNK_OVERLAP_CHARS = envInt("EXTRACT_CHUNK_OVERLAP", 2_000);

/**
 * Ceiling on chunks per document, so one pathological 200k-char email cannot
 * monopolize the model. Hitting it is logged with the number of characters
 * abandoned. At the default this covers ~200k chars, i.e. the whole
 * MAX_BODY_CHARS the worker will ever store.
 */
export const MAX_CHUNKS = envInt("EXTRACT_MAX_CHUNKS", 10);

/**
 * Wall-clock ceiling for a single model call. The local path had none, which
 * is the difference between "this email failed and will retry" and "the inbox
 * stopped". Generous because a cold 33B model has to page into VRAM first.
 */
export const LLM_TIMEOUT_MS = envInt("EXTRACT_LLM_TIMEOUT_MS", 180_000);

/**
 * Extra attempts for one model call after the first fails. Covers a model
 * being swapped in or a momentary connection reset, not a broken prompt.
 */
export const LLM_RETRIES = envInt("EXTRACT_LLM_RETRIES", 1);

/** Backoff before that retry. */
export const LLM_RETRY_DELAY_MS = envInt("EXTRACT_LLM_RETRY_DELAY_MS", 2_000);

/**
 * The one policy for "a model call took too long", per provider. The Ollama
 * JSON client, the CLI spawn and the graph's node policies all read this;
 * four unrelated timeout-and-retry rules used to describe the same event.
 *
 * `timeoutMs` caps one whole call. `idleTimeoutMs` is the streaming leash: a
 * healthy stream refreshes it per token, a stalled one fails there instead of
 * eating the whole HTTP deadline. Subscription CLIs never retry (a re-run
 * spends real tokens on a duplicate turn) and get a longer idle leash because
 * their tool phases stream nothing.
 */
export interface LlmPolicy {
  timeoutMs: number;
  idleTimeoutMs: number;
  retries: number;
  retryDelayMs: number;
}

export function llmPolicy(provider: string): LlmPolicy {
  if (provider === "ollama") {
    return {
      timeoutMs: LLM_TIMEOUT_MS,
      idleTimeoutMs: envInt("LLM_IDLE_TIMEOUT_MS", 45_000),
      retries: LLM_RETRIES,
      retryDelayMs: LLM_RETRY_DELAY_MS,
    };
  }
  return {
    timeoutMs: envInt("CLI_TIMEOUT_MS", 110_000),
    idleTimeoutMs: envInt("CLI_IDLE_TIMEOUT_MS", 115_000),
    retries: 0,
    retryDelayMs: 0,
  };
}

/**
 * How many times a single email may fail extraction before the pipeline stops
 * picking it up. Without this a poison row (one the model reliably chokes on)
 * is re-selected by every kick forever, burning a full model pass each time
 * and starving the mail behind it. Exhausted rows keep their error and stay
 * visible in the admin inbox; "Reprocess" still forces a retry by hand.
 */
export const MAX_ATTEMPTS = envInt("INBOX_MAX_ATTEMPTS", 4);
