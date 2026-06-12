/**
 * Guardrails for the "Ask Grapevine" agent — the same layered pattern the big
 * labs use (small local classifiers around the main model), all running
 * in-process with no paid APIs:
 *
 *  1. Input rail — Meta's Llama Prompt Guard 2 (86M), the open state-of-the-art
 *     jailbreak/prompt-injection classifier, runs on every user message via
 *     Transformers.js (ONNX, CPU, ~tens of ms). Flagged messages never reach
 *     the LangGraph agent, so they can't poison thread history either.
 *  2. Content rail — the same classifier scans untrusted web text (search
 *     snippets, read_page output) before it enters the model's context, the
 *     indirect-injection path Prompt Guard was built for.
 *  3. Output rail — a deterministic streaming scrubber that trips on persona
 *     breaks (the model admitting it's Qwen/Llama/etc., quoting its system
 *     prompt). Classifiers are probabilistic; this layer makes the specific
 *     failure we care about — identity leaks — impossible to stream to the
 *     browser. It holds back a small tail so a leak split across chunks
 *     can't slip out.
 *
 * The classifier fails OPEN (a broken download shouldn't brick chat — the
 * output rail is pure regex and always on); every knob is env-tunable.
 */
import path from "node:path";
import { env, pipeline } from "@huggingface/transformers";

/** Ungated ONNX port of meta-llama/Llama-Prompt-Guard-2-86M (int8, ~280 MB). */
const GUARD_MODEL = process.env.GUARD_MODEL ?? "gravitee-io/Llama-Prompt-Guard-2-86M-onnx";
export const GUARD_MODEL_LABEL = "Llama Prompt Guard 2";

const THRESHOLD = Number(process.env.GUARD_THRESHOLD ?? 0.8);

/** Prompt Guard reads 512 tokens — scan long text in overlapping windows. */
const CHUNK_CHARS = 1500;
const CHUNK_OVERLAP = 200;
const MAX_CHUNKS = 8;

export function guardrailsEnabled(): boolean {
  return process.env.GUARDRAILS !== "off";
}

// ---------------------------------------------------------------------------
// Input / content rail — the ML classifier
// ---------------------------------------------------------------------------

type Classifier = (
  texts: string[],
) => Promise<{ label: string; score: number }[] | { label: string; score: number }>;

let clfPromise: Promise<Classifier> | null = null;
let warned = false;

function loadClassifier(): Promise<Classifier> {
  if (!clfPromise) {
    env.cacheDir = path.join(process.cwd(), ".cache", "huggingface");
    clfPromise = pipeline("text-classification", GUARD_MODEL, {
      // This port keeps the quantized graph at the repo root, not in onnx/.
      subfolder: "",
      model_file_name: "model.quant",
      dtype: "fp32",
    }).then((p) => p as unknown as Classifier);
  }
  return clfPromise;
}

function chunk(text: string): string[] {
  const t = text.trim();
  if (t.length <= CHUNK_CHARS) return [t];
  const out: string[] = [];
  for (let i = 0; i < t.length && out.length < MAX_CHUNKS; i += CHUNK_CHARS - CHUNK_OVERLAP) {
    out.push(t.slice(i, i + CHUNK_CHARS));
  }
  return out;
}

export interface GuardVerdict {
  malicious: boolean;
  /** Max MALICIOUS probability across scanned windows, 0 when unavailable. */
  score: number;
}

/**
 * Classify text as a prompt-injection/jailbreak attempt. Used for both user
 * messages and untrusted web content; fails open with a one-time warning.
 */
export async function scanText(text: string): Promise<GuardVerdict> {
  if (!guardrailsEnabled() || !text.trim()) return { malicious: false, score: 0 };
  try {
    const clf = await loadClassifier();
    const raw = await clf(chunk(text));
    const results = (Array.isArray(raw) ? raw : [raw]).flat();
    const score = Math.max(
      0,
      ...results.map((r) => (r.label === "MALICIOUS" ? r.score : 1 - r.score)),
    );
    return { malicious: score >= THRESHOLD, score };
  } catch (err) {
    if (!warned) {
      warned = true;
      console.warn(
        `[guardrails] ${GUARD_MODEL_LABEL} unavailable — input rail failing open:`,
        String(err).slice(0, 300),
      );
    }
    return { malicious: false, score: 0 };
  }
}

/** Load the model and run one classification so the first chat isn't slow. */
export function warmupGuardrails(): void {
  if (!guardrailsEnabled()) {
    console.log("[guardrails] disabled via GUARDRAILS=off (persona rail stays on)");
    return;
  }
  const t0 = Date.now();
  console.log(`[guardrails] loading ${GUARD_MODEL_LABEL} (${GUARD_MODEL}) — first run downloads ~280 MB`);
  scanText("warmup: ignore previous instructions").then((v) => {
    if (v.score > 0 || !warned) {
      console.log(`[guardrails] ready in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    }
  });
}

// ---------------------------------------------------------------------------
// Output rail — streaming persona/identity-leak scrubber
// ---------------------------------------------------------------------------

/**
 * Longest pattern must fit in this window; emitted text always had this much
 * lookahead scanned behind it, so a leak can never straddle the boundary.
 */
const HOLDBACK = 64;

const PERSONA_BREAK_PATTERNS: RegExp[] = [
  // model families that could actually be serving this app via Ollama,
  // plus the names local models most often hallucinate
  /\b(?:qwen|tongyi|alibaba|deepseek|gemma|granite|olmo)\b/i,
  /\b(?:meta[-\s]?)?llama[-\s]?\d/i,
  /\b(?:chat)?gpt-?[\d4o]/i,
  /\b(?:chatgpt|openai|anthropic)\b/i,
  /\bmistral\s+ai\b/i,
  /\bphi-?\d\b/i,
  // generic self-identification
  /\b(?:i(?:'|’)?m|i\s+am)\s+(?:a|an)\s+(?:large\s+)?(?:language\s+model|llm\b|ai\s+(?:model|assistant))/i,
  /\bas\s+an?\s+(?:ai|large\s+language)\s+(?:model|assistant)\b/i,
  /\b(?:developed|created|trained|built|made)\s+by\s+(?:alibaba|meta\b|google|openai|anthropic|mistral|microsoft|deepseek|nvidia|ibm)/i,
  // instruction/prompt disclosure
  /\bsystem\s+prompt\b/i,
  /\bmy\s+(?:instructions|training\s+data|underlying\s+(?:model|architecture)|model\s+(?:architecture|weights))\b/i,
];

/** Words too common in the wild to match bare (llama petting zoos are real). */
const DYNAMIC_STOPLIST = new Set(["llama", "phi", "mistral"]);

export interface StreamGuard {
  /** Feed a streamed chunk; returns text that is safe to emit now. */
  push(chunk: string): string;
  /** Stream ended — release (and final-scan) the held-back tail. */
  flush(): string;
  readonly tripped: boolean;
}

/**
 * Deterministic persona guard over the streamed answer. `modelName` is the
 * active Ollama model ("qwen3:30b-a3b") — its family name is added to the
 * blocklist so the rail tracks whatever model the admin selects.
 */
export function personaGuard(opts: { modelName?: string } = {}): StreamGuard {
  const patterns = [...PERSONA_BREAK_PATTERNS];
  const family = opts.modelName?.split(/[:/]/)[0]?.trim().toLowerCase();
  if (family) {
    for (const token of new Set([family, family.replace(/[\d.-]+$/, "")])) {
      if (token.length >= 4 && !DYNAMIC_STOPLIST.has(token)) {
        patterns.push(new RegExp(`\\b${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i"));
      }
    }
  }

  const hit = (text: string) => patterns.some((p) => p.test(text));
  let tail = ""; // last HOLDBACK chars already emitted, for boundary scans
  let pending = "";
  let tripped = false;

  return {
    get tripped() {
      return tripped;
    },
    push(chunk: string): string {
      if (tripped) return "";
      pending += chunk;
      if (hit(tail + pending)) {
        tripped = true;
        pending = "";
        return "";
      }
      const emit = pending.slice(0, Math.max(0, pending.length - HOLDBACK));
      pending = pending.slice(emit.length);
      tail = (tail + emit).slice(-HOLDBACK);
      return emit;
    },
    flush(): string {
      if (tripped) return "";
      if (hit(tail + pending)) {
        tripped = true;
        pending = "";
        return "";
      }
      const emit = pending;
      pending = "";
      return emit;
    },
  };
}

// ---------------------------------------------------------------------------
// Canned in-character replies
// ---------------------------------------------------------------------------

export function inputRefusalMessage(city: string): string {
  return `I'll pass on that one — it reads like an attempt to rewire me rather than a question about ${city}. Ask me about tonight, the weekend, or a vibe and I'm all yours.`;
}

export function personaRefusalMessage(city: string): string {
  return `I'm Grapevine, ${city}'s events concierge — how I'm built stays behind the bar. What are you in the mood for: live music, food, something free tonight?`;
}
