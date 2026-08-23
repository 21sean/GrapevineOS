/**
 * The register behind Admin → Evals → Production notes.
 *
 * Content, not code, kept out of EvalsTab.tsx so the panel stays a panel. Each
 * entry names a way an eval harness fails in production and says what was done
 * about it, including the things that were deliberately NOT done — a limits
 * section that lists nothing is the tell that nobody looked.
 */

export interface HardeningNote {
  /** The failure mode, stated as the thing that goes wrong. */
  risk: string
  /** What the code actually does about it. */
  handled: string
  /** Where to look. */
  where?: string
}

export const HARDENING: { title: string; items: HardeningNote[] }[] = [
  {
    title: "Trusting the number",
    items: [
      {
        risk: "A suite that reads the real clock, the live web, or the database goes red for reasons nobody can fix.",
        handled:
          "Every offline suite runs against a frozen catalog at a frozen instant: no network, no model, no database, same answer every time. Two flaky runs is all it takes before a dashboard stops being read.",
        where: "server/src/evals/fixtures.ts",
      },
      {
        risk: "Fixtures decay, and cases quietly start passing for the wrong reason.",
        handled:
          "A case asserts the fixture catalog still contains a promoted, recurring, free, ticketed, expired, far-away, and currently-live event. Delete the promoted listing and the guard fails before the cases that depend on it can go green vacuously.",
        where: "personas / grounding-fixture-covers-the-map",
      },
      {
        risk: "Cases that have never failed are not evidence of anything.",
        handled:
          "The suite was mutation-checked: flipping the promoted flag on one fixture event turned three cases red with the exact ids they were guarding, then green again on revert.",
      },
      {
        risk: "A rewritten suite reads as a regression, so the regression list becomes noise.",
        handled:
          "Each run is fingerprinted by its case-set. Scores and pass/fail deltas are only compared across runs that asked identical questions; a changed fingerprint is reported as a different question, not a worse answer.",
        where: "runner.ts caseSetHash",
      },
      {
        risk: "The dashboard and the CI gate drift until nobody knows which one is lying.",
        handled:
          "One registry, two front ends. `npm run evals` and this panel execute the same case objects and the same thresholds; the CLI exits non-zero on any failure so it works as a pre-push hook.",
        where: "server/src/evals/registry.ts",
      },
    ],
  },
  {
    title: "Failing safely",
    items: [
      {
        risk: "One unexpected exception ends the run and the twenty cases after it report nothing.",
        handled:
          "Every case is isolated. A thrown assertion is a failed case, anything else is a failed case labelled with what it threw, and the run continues either way.",
      },
      {
        risk: "A wedged model or a socket that never answers hangs the run forever.",
        handled:
          "Each case has a wall-clock budget — 15s, raised to 120s for the suite that loads an 86M-parameter classifier. Honest limit: this bounds awaiting, not CPU. JavaScript has no preemption, so a genuinely spinning loop still wins.",
      },
      {
        risk: "A broken fixture takes down the whole run instead of one suite.",
        handled:
          "Building a suite's case list is itself wrapped. A suite whose fixtures fail to load is reported as one skipped suite with the reason attached.",
      },
      {
        risk: "A skipped check looks like a passing check.",
        handled:
          "Skipped is a third state everywhere: it never counts toward a score, and a run with any skipped suite is reported as skipped rather than green. An unrun check is unknown, and unknown must not read as fine.",
      },
      {
        risk: "The guardrail fails open, so a broken rail and a working rail look identical.",
        handled:
          "scanText returns benign when the classifier will not load — correct for production, fatal for an eval. The suite probes with a known injection first and skips itself if the score comes back flat zero, rather than reporting sixteen false passes.",
        where: "suites/guardrails.ts available()",
      },
    ],
  },
  {
    title: "Running it",
    items: [
      {
        risk: "Two concurrent runs contend for the CPU and each reports the other's latency as a regression.",
        handled:
          "Runs are serialized process-wide. A second request gets 409 with the reason instead of a queue nobody asked for.",
      },
      {
        risk: "Closing the panel leaves work running and writes a half-finished run into history.",
        handled:
          "A closed connection aborts the run between cases, and an aborted run is never recorded — otherwise the partial result becomes the baseline every later run is compared against.",
      },
      {
        risk: "A long run behind a silent request is indistinguishable from a hung server.",
        handled:
          "Results stream as NDJSON, one frame per case, with proxy buffering disabled. The panel shows which case is running and how many are left.",
      },
      {
        risk: "The offline gate cannot run in CI because it needs production credentials.",
        handled:
          "The Supabase client is now built on first query rather than at import, so code that never touches the database no longer needs its keys to load. `npm run evals` runs on a bare checkout.",
        where: "server/src/db.ts",
      },
    ],
  },
  {
    title: "What the output is allowed to say",
    items: [
      {
        risk: "A case echoes a value that turns out to contain a credential, and the screenshot goes in a pull request.",
        handled:
          "Case details are scrubbed by value, not by pattern: every environment value long enough to be a secret is masked wherever it appears. Prefix matching only ever catches the shapes you thought of; the process already knows exactly which strings are its secrets.",
        where: "harness.ts scrubSecrets",
      },
      {
        risk: "Stack traces leak paths and internals into an operator panel.",
        handled:
          "Failures carry the message only, flattened to one line and capped at 300 characters.",
      },
      {
        risk: "Personas look enough like accounts that someone wires one to auth.",
        handled:
          "They are plain fixtures with non-uuid ids. They never touch the auth path, never write to the database, and the wire shape sent to the browser drops their coordinates and raw reaction map.",
      },
      {
        risk: "Anyone who can reach the server can start a run.",
        handled:
          "Set ADMIN_EMAILS and these routes require a signed-in user on that list. Unset, they are open — the same posture as every other admin route in this app, stated here rather than assumed.",
        where: "server/src/evals/index.ts",
      },
    ],
  },
  {
    title: "History",
    items: [
      {
        risk: "Only ever seeing the current run answers 'is it green' but never 'what changed'.",
        handled:
          "Each run is kept and stamped with the cases that newly failed and newly passed against the last comparable run. That list is what turns a red panel into a bisect.",
      },
      {
        risk: "Operator telemetry grows into something that has to be managed.",
        handled:
          "A capped JSONL file next to the server, twenty-five runs deep. Deliberately not a database table: no migration, no network round trip before the panel can show a number, and deleting the file is a supported way to reset.",
        where: "server/.evals/history.jsonl",
      },
      {
        risk: "A run is lost because the disk was read-only, or a line was truncated by a kill mid-write.",
        handled:
          "Write failures warn once and are otherwise ignored — a run that produced results is not thrown away because it could not be filed. Unparseable lines are skipped on read.",
      },
    ],
  },
  {
    title: "What this does not cover",
    items: [
      {
        risk: "These suites gate logic, not integration.",
        handled:
          "Nothing here exercises the live model, Postgres, Mapbox, or the discovery crawl. Those need their own checks against a staging catalog; the honest reading of a green panel is that the deterministic core is correct, not that the system is up.",
      },
      {
        risk: "Recurrence expansion caps at 3000 steps.",
        handled:
          "A daily series running longer than about eight years resolves to a past occurrence, and callers then drop it. The cap is the deliberate trade — a missing event rather than a hung request or a wrong date — and a case pins that it fails in that direction.",
        where: "recurrence / expansion-is-bounded",
      },
      {
        risk: "The input rail is probabilistic, so demanding it block everything would encode a fantasy.",
        handled:
          "Polite identity probes ('which llm') are questions, not injections, and are expected to pass the classifier. The prompt hardening and the deterministic persona rail catch those instead, and the suite asserts each layer against what that layer actually does.",
      },
      {
        risk: "The judged suites are stochastic, and a red one is not automatically a bug.",
        handled:
          "They run a local judge over transcripts a local model produced, so two runs of identical code give slightly different scores. Their thresholds sit below 1 for that reason (0.67 and 0.75), and a single failure is a prompt to read the transcript, not to revert a commit. Every other suite on this page is still a deterministic assertion at threshold 1.",
        where: "guardrails-judge, guardrails-redteam",
      },
      {
        risk: "The red team runs without tools.",
        handled:
          "Adversarial conversations bind no toolbox: a red-team run is about what the model says, and tool calls against a frozen fixture catalog would spend the whole budget on ETA lookups. The tool-borne attack path is the content rail's, covered by the calibration corpus and by the envelope cases in the guardrails suite instead.",
        where: "server/src/evals/redteam.ts",
      },
      {
        risk: "A hand-written attack ladder only finds the failures whoever wrote it imagined.",
        handled:
          "The attacks are PyRIT's — Microsoft's Crescendo and red-teaming loops, with their adversarial prompts, their backtracking on refusal, and their scorers. We supply the target adapter and the objectives that are specific to this app, and nothing else. It runs entirely on the local Ollama daemon; no hosted red-team service is involved.",
        where: "server/redteam/run_attack.py",
      },
    ],
  },
  {
    title: "Guardrail calibration",
    items: [
      {
        risk: "A threshold nobody can check is a threshold nobody can defend.",
        handled:
          "The rails scored every message and surfaced only the blocks, so 0.8 was a number with no evidence behind it. Every decision is now recorded (Admin -> Guardrails) and scored against a labelled corpus on every run, which turns the question into a measurement.",
        where: "server/src/evals/corpus.ts",
      },
      {
        risk: "Counting attacks the classifier was never designed to catch makes the obvious fix the wrong one.",
        handled:
          "Prompt Guard 2 detects explicit instructions aimed at a model; Meta narrowed it away from conversational social engineering deliberately, to cut false positives. Corpus entries carry a scope saying which layer owns them, set by a rule stated before the scores were looked at. Pooling roleplay framing into the score would report the rail as weak at a job it does not have.",
        where: "corpus.ts / SCOPE_RULE",
      },
      {
        risk: "Tuning a threshold that has nothing to tune.",
        handled:
          "The measured distribution is bimodal with a dead band from 0.055 to 0.606: every threshold inside it behaves identically, and the in-scope attacks that get through score ~0.001, so no threshold above zero recovers them. A case asserts that a retune buys nothing, and fails the day that stops being true.",
        where: "guardrails-calibration / calibration-threshold-is-insensitive",
      },
      {
        risk: "A false positive is the failure that gets a rail switched off for good.",
        handled:
          "Ten benign corpus entries are written to read like injections on purpose, and the suite asserts none of them is blocked and that the threshold clears the loudest of them with margin. That number is checked every run, not the day someone remembers to look.",
        where: "guardrails-calibration / calibration-no-false-positives",
      },
      {
        risk: "A pattern list only catches the failures somebody already wrote a pattern for.",
        handled:
          "The judged suite runs a judge over persona breaks the regex rail provably misses, and asserts the rail does NOT trip on them first. If one ever starts matching, that case fails rather than quietly asserting nothing.",
        where: "guardrails-judge",
      },
      {
        risk: "Synthetic scans polluting the distribution they are meant to describe.",
        handled:
          "Corpus scans, the warmup probe and every simulated conversation pass record:false, so nothing the harness generates enters the recorded traffic. A histogram containing its own eval runs would show an attack rate nobody is actually sending.",
        where: "server/src/agent/telemetry.ts",
      },
    ],
  },
]
