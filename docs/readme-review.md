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

## Evidence still worth collecting

These are follow-up opportunities, not completed checklist items:

| Status  | Evidence gap                                  | What would close it                                                                                                                       |
| ------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Pending | Human calibration of the local judge          | Completed blind human reviews in [the calibration record](../llm/calibration.md), with disagreements and follow-up cases.                 |
| Pending | Live retrieval quality                        | A labeled event-query dataset run through the actual retriever, with precision/recall and failure analysis separate from snapshot scores. |
| Pending | Independent answer-quality evidence           | A larger held-out set with human labels or an independently calibrated judge, reported with sample size and uncertainty.                  |
| Pending | Representative performance and product impact | Reproducible latency/throughput measurements with hardware and workload, plus verified usage or user-outcome data if available.           |

The strongest interview discussion is how strict contracts, evidence validation,
tool permissions, and evaluation gates work together, including where each can
still fail. A valid schema is one guarantee; it is not a claim of universal accuracy.
