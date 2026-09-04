/**
 * The eval harness: how a case is written, how it fails, and what a failure is
 * allowed to say.
 *
 * A case is a function that returns the thing it observed, as a short string,
 * and throws to fail. That shape is deliberate. `expect` throwing means the
 * first broken assumption stops the case with a message that names the actual
 * value, so a red case in the admin panel already tells you what went wrong;
 * returning a detail on success means a green case still shows its work, which
 * is what makes a passing suite worth looking at rather than a wall of ticks.
 *
 * Two rules the runner enforces on every message that comes back out:
 * no stack traces (they are noise in a panel and a disclosure risk in a
 * screenshot) and no secrets (see scrubSecrets).
 */
import type { EvalKind } from "../types.js";

/** Thrown by `expect`. Its message is shown verbatim as the case detail. */
export class EvalAssertion extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvalAssertion";
  }
}

/**
 * Thrown by a case that cannot be judged right now — a missing model, a
 * dependency that is down. Skipped is not passed: it is counted separately and
 * never contributes to a green suite.
 */
export class EvalSkip extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvalSkip";
  }
}

export function expect(cond: unknown, message: string): asserts cond {
  if (!cond) throw new EvalAssertion(message);
}

export function skip(reason: string): never {
  throw new EvalSkip(reason);
}

/** Compact, stable rendering so `got X, wanted Y` reads the same every run. */
export function show(v: unknown): string {
  if (typeof v === "string") return JSON.stringify(v);
  if (v instanceof Set) return `{${[...v].map(String).sort().join(", ")}}`;
  if (v instanceof Map) return show(Object.fromEntries(v));
  if (v === undefined) return "undefined";
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

export function expectEq(got: unknown, want: unknown, label: string): void {
  const g = show(got);
  const w = show(want);
  if (g !== w) throw new EvalAssertion(`${label}: got ${g}, wanted ${w}`);
}

/** Set-equality on ids, with both directions named — the common list check. */
export function expectIds(got: string[], want: string[], label: string): void {
  const missing = want.filter((id) => !got.includes(id));
  const extra = got.filter((id) => !want.includes(id));
  if (missing.length || extra.length) {
    const parts = [
      missing.length ? `missing ${missing.join(", ")}` : "",
      extra.length ? `unexpected ${extra.join(", ")}` : "",
    ].filter(Boolean);
    throw new EvalAssertion(`${label}: ${parts.join("; ")}`);
  }
}

// ---------------------------------------------------------------------------
// Suite shape
// ---------------------------------------------------------------------------

export interface EvalCase {
  /** Stable across runs — history compares cases by id, not by position. */
  id: string;
  name: string;
  /** The regression this case exists to catch. Shown under the case name. */
  note?: string;
  /** Returns what it observed; throws EvalAssertion to fail, EvalSkip to skip. */
  run: () => string | Promise<string>;
}

export interface EvalSuite {
  id: string;
  title: string;
  /** One line: what breaks for a user if this suite goes red. */
  what: string;
  kind: EvalKind;
  /**
   * Score the suite must reach to count as passing. Every suite here is 1:
   * these are assertions about deterministic code, so "most of them hold" is
   * not a result anyone should ship on. The knob exists because a graded
   * suite (an LLM judge, a retrieval@k score) genuinely needs one, and the
   * runner should not have to change shape the day that suite arrives.
   */
  threshold: number;
  /** Per-case wall-clock budget. Bounds awaits, not a spinning loop. */
  timeoutMs?: number;
  /** Non-null reason the suite cannot run right now (missing model, etc.). */
  available?: () => Promise<string | null>;
  cases: () => EvalCase[] | Promise<EvalCase[]>;
}

// ---------------------------------------------------------------------------
// Output safety
// ---------------------------------------------------------------------------

/**
 * Case details are rendered in a browser panel and pasted into pull requests,
 * so anything a case echoes back has to be safe to read out loud.
 *
 * This scrubs by VALUE, not by pattern: every environment value long enough to
 * be a credential is replaced wherever it appears in the text. Pattern-matching
 * on prefixes (sk-, ghp_, …) only ever catches the shapes you thought of; the
 * process already knows exactly which strings are its secrets.
 */
const SECRET_MIN_LENGTH = 12;

/** Env names that are configuration rather than credentials. */
const NOT_SECRET =
  /^(NODE_|npm_|PATH$|PWD$|HOME$|LANG|TERM|TZ$|SHELL$|USER$|LOGNAME$|TMPDIR$|OS$|COMPUTERNAME$|PROCESSOR|SYSTEM|WINDIR|PUBLIC$|ALLUSERSPROFILE$|COMMONPROGRAM|PROGRAM|APPDATA$|LOCALAPPDATA$|SESSIONNAME$|USERDOMAIN|USERNAME$|USERPROFILE$|HOMEDRIVE$|HOMEPATH$|LOGONSERVER$|DRIVERDATA$|PSMODULEPATH$|PATHEXT$|COMSPEC$|NUMBER_OF_PROCESSORS$|CLAUDE)/i;

function secretValues(): string[] {
  return (
    Object.entries(process.env)
      .filter(([k, v]) => !!v && v.length >= SECRET_MIN_LENGTH && !NOT_SECRET.test(k))
      .map(([, v]) => v!)
      // Longest first, so a value that contains another is masked whole.
      .sort((a, b) => b.length - a.length)
  );
}

export function scrubSecrets(text: string): string {
  let out = text;
  for (const v of secretValues()) {
    if (out.includes(v)) out = out.split(v).join("[redacted]");
  }
  return out;
}

/** One line, bounded, secret-free, stack-free. */
export function safeDetail(text: string, max = 300): string {
  const flat = scrubSecrets(text).replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
