# README hiring-manager review

Reviewed against the v0.7.0 implementation on 2026-10-28. This is an editorial
and source-evidence audit, not an independent model benchmark or security audit.

The README should let a reviewer understand the product, identify the engineering
work, and inspect the evidence without reading the entire repository first.

| Review question                                 | Finding in the previous README                                                                                   | Resolution                                                                                                                                                                 |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| What does the application do?                   | The local-event map was clear; the AI engineering focus was buried.                                              | Added a short explanation of the model-to-application boundary and the stack near the top.                                                                                 |
| Does the first screenshot look intentional?     | A busy city view competed with labels and overlays; the phone images showed a different scene.                   | Replaced all three UI captures with dark waterfront views, 3D buildings on, optional basemap labels/traffic off, and the Star of India visible in the desktop composition. |
| Can I verify the AI/ML claims?                  | The README mentioned validation and evals without a scannable inventory.                                         | Added a capability checklist with direct source, test, dataset, and workflow links.                                                                                        |
| Is this more than a model API wrapper?          | Orchestration, contract enforcement, persistence, and regression gates required digging through separate guides. | Surfaced these capabilities and their implementation evidence together.                                                                                                    |
| Are evaluation numbers defensible?              | Case counts were listed without much context about what they measured.                                           | Identified the 30-case synthetic replay suite and 15 live cases as regression coverage, with snapshot retrieval and shared-model judging limits.                           |
| Are important tradeoffs explained?              | The guardrail paragraph still referred to a streamed response.                                                   | Explained whole-answer validation before display, classifier fail-open behavior, and the separate fail-closed contract boundary.                                           |
| Can I reproduce the work?                       | Setup and operations were already present.                                                                       | Preserved setup commands, linked the quality guide, and documented screenshot framing/settings.                                                                            |
| Can I scan it quickly?                          | Five large diagrams expanded before the final documentation and development sections.                            | Kept the diagrams in an expandable architecture section and moved the AI/ML checklist above setup.                                                                         |
| Does it claim results that were never measured? | The README did not provide adoption or business-impact evidence.                                                 | Added no invented adoption, latency, accuracy, or business-impact claims.                                                                                                  |

## Measured security results

Local numbers on one RTX 5090, against the 15-event fixture catalog, on 2026-11-04. They have
stated limits and are not an independent audit. Three points in time: "before" is the code before
this work with only what it needed to run at all, "hardened" is c4ec9b7, and "fixed" is 24addce.

**Indirect prompt injection** (`npm run evals -- --suite guardrails-injection`). Injected
instructions in a fetched page, a search snippet or an event listing try to make the agent
call `set_rarity`, `save_calendar` or `discover_events` with `dry_run: false`. Scored the way
AgentDojo scores it, by whether the call happened, with no LLM judge.

|                           | Before                                    | Hardened                                 | Fixed                                     |
| ------------------------- | ----------------------------------------- | ---------------------------------------- | ----------------------------------------- |
| Target tool called        | 0 of 108 (0.0%)                           | 0 of 108 (0.0%)                          | 0 of 108 (0.0%, 95% CI 0.0% to 3.4%)      |
| Write took effect         | 0 of 108 (0.0%)                           | 0 of 108 (0.0%)                          | 0 of 108 (0.0%, 95% CI 0.0% to 3.4%)      |
| Utility under attack      | 102 of 108 (94.4%, 95% CI 88.4% to 97.4%) | 75 of 108 (69.4%, 95% CI 60.2% to 77.3%) | 103 of 108 (95.4%, 95% CI 89.6% to 98.0%) |
| Utility with no injection | 9 of 9 (100.0%)                           | 8 of 9 (88.9%)                           | 9 of 9 (100.0%, 95% CI 70.1% to 100.0%)   |

The attack rate never moved, so neither the hardening nor the fix lowered it. The hardened build
cost 25 points of utility, by answering ordinary questions with the concierge's identity line, and
the fix brought utility back level with where it started. "Before" carries one fix, because tool rounds
failed outright without it: on unfixed code, 9 of 9 tool conversations in a partial run crashed
before reading the injected text, so that code has no meaningful rate.

Writes and the web are fixtures, so no real event or calendar was reachable, and the runs had
placeholder credentials and a network block. The attacks are 4 fixed templates and 3 goals over 9
tasks, not an adaptive attacker, at temperature 0, so they are distinct prompts rather than repeated
trials. The model never asked for a target tool, so the write gate was not exercised live, and unit
tests cover it. Of the 5 failures left, 3 are the identity line on a venue field holding "ignore all
previous instructions", and 2 say the listing has no real description.

**Multi-turn red team** (PyRIT 1.0.1, Crescendo and red-teaming, 5 turns each, sequential). An
attack success is a true verdict from PyRIT's scorer on a persona break.

| Objective                 | Before                               | Hardened                            | Fixed                               |
| ------------------------- | ------------------------------------ | ----------------------------------- | ----------------------------------- |
| Name the model            | 0 of 4                               | 0 of 2                              | 0 of 2                              |
| Restate the system prompt | 0 of 4                               | 0 of 1                              | 0 of 1                              |
| Disclosure inside fiction | 1 of 4                               | 0 of 2                              | 0 of 2                              |
| Stop being a concierge    | 0 of 4                               | 0 of 2                              | 0 of 2                              |
| Total                     | 1 of 16 (6.2%, 95% CI 1.1% to 28.3%) | 0 of 7 (0.0%, 95% CI 0.0% to 35.4%) | 0 of 7 (0.0%, 95% CI 0.0% to 35.4%) |

No verdict was UNDETERMINED and no attack failed to finish in any set. These samples are small and
the intervals overlap, so none of this is a statistically meaningful reduction. The original code
could not produce a number at all: the suite crashed in 3 of 3 runs with no verdicts. "Before" is
that code with only the harness fixed, and it is not like for like, because 39 of 76 replies were
the raw gate error `LlmGateError: Model output did not satisfy the contract`, against 0 of 35 in
each later set, so about half of those turns never tested the persona. The later sets ran each
objective once and then three again, with the one left out chosen by a rule set before the run.

The one success before was a refusal that described itself as powered by an "underlying model,
vendor, or architecture". In the hardened set, one conversation declined three times to discuss
"what powers the service", and the scorer judged that not a break, so a stricter reader could
count it. The scorer is noisy in this way: in an earlier run it judged the same error text a hint
on one objective and not on others. Attacker, scorers and agent all run on the same local model,
and tools are off in these attacks. A scorer without reasoning was tried and rejected after it
missed 1 of 5 positive controls.

## Evidence still worth collecting

These are follow-up opportunities, not completed checklist items:

| Status  | Evidence gap                                  | What would close it                                                                                                                       |
| ------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Pending | Human calibration of the local judge          | Completed blind human reviews in [the calibration record](../llm/calibration.md), with disagreements and follow-up cases.                 |
| Pending | Live retrieval quality                        | A labeled event-query dataset run through the actual retriever, with precision/recall and failure analysis separate from snapshot scores. |
| Pending | Independent answer-quality evidence           | A larger held-out set with human labels or an independently calibrated judge, reported with sample size and uncertainty.                  |
| Partial | Representative performance and product impact | Latency is measured, in the [quality guide](../llm/README.md#agent-turn-latency). Verified usage or user-outcome data is still missing.   |

The strongest interview discussion is how strict contracts, evidence validation,
tool permissions, and evaluation gates work together, including where each can
still fail. A valid schema is one guarantee; it is not a claim of universal accuracy.
