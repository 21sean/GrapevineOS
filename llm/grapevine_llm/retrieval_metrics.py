"""
Ragas over two questions about one agent turn, both answered from IDs alone.

  retrieval: of the evidence that was put in front of the model, how much was relevant
             (precision), and was everything relevant there (recall)? This scores the
             reviewed snapshot in the golden case, not the live retriever.
  citation:  of the evidence the answer actually cited, how much was relevant, and did
             it cite everything relevant? This scores the model's output on every run,
             so it moves when grounding gets better or worse.

Both are Ragas's ID-based context precision and recall with the first argument
changed. They are deterministic: no model, no network, no disk cache.
"""
import asyncio
import warnings

from ragas import SingleTurnSample

with warnings.catch_warnings():
    # Ragas 0.4 deprecates this import path and says the ID metrics have no equivalent
    # in ragas.metrics.collections; they are due to go in 1.0. The dependency is pinned
    # below 0.5, and test_ragas_matches_the_set_arithmetic keeps the definition on record.
    warnings.filterwarnings("ignore", category=DeprecationWarning, module=r"ragas(\..*)?")
    warnings.filterwarnings("ignore", message=r"Importing IDBased.*", category=DeprecationWarning)
    from ragas.metrics import IDBasedContextPrecision, IDBasedContextRecall


def score_ids(retrieved: list[str], relevant: list[str]) -> tuple[float, float]:
    """(precision, recall) of `retrieved` against `relevant`."""
    # Explicit empty-set semantics avoid Ragas's NaN becoming a passing score.
    if not relevant:
        return (1.0 if not retrieved else 0.0), 1.0
    if not retrieved:
        return 0.0, 0.0
    sample = SingleTurnSample(retrieved_context_ids=retrieved, reference_context_ids=relevant)

    async def score():
        # One loop for both, instead of starting a second one for recall.
        return await asyncio.gather(IDBasedContextPrecision().single_turn_ascore(sample),
                                    IDBasedContextRecall().single_turn_ascore(sample))

    precision, recall = asyncio.run(score())
    return float(precision), float(recall)


def score_citations(cited: list[str], relevant: list[str]) -> tuple[float, float]:
    """
    (precision, recall) of what an answer cited. Citing nothing when nothing was relevant
    is correct and scores (1, 1); citing anything in that case scores precision 0.
    Duplicate citations count once: citing the same event twice adds no support.
    """
    return score_ids(list(dict.fromkeys(cited)), relevant)


def mean(values: list[float | None]) -> float | None:
    """Macro average over the cases that have the metric, or None when none do."""
    seen = [v for v in values if v is not None]
    return sum(seen) / len(seen) if seen else None
