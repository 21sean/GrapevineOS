"""Ragas deterministic metrics over reviewed retrieval snapshots; no model downloads."""
import asyncio

from ragas import SingleTurnSample
from ragas.metrics import IDBasedContextPrecision, IDBasedContextRecall


def score_ids(retrieved: list[str], relevant: list[str]) -> tuple[float, float]:
    # Explicit empty-set semantics avoid Ragas's NaN becoming a passing score.
    if not relevant:
        return (1.0 if not retrieved else 0.0), 1.0
    if not retrieved:
        return 0.0, 0.0
    sample = SingleTurnSample(retrieved_context_ids=retrieved, reference_context_ids=relevant)

    async def score():
        precision = await IDBasedContextPrecision().single_turn_ascore(sample)
        recall = await IDBasedContextRecall().single_turn_ascore(sample)
        return float(precision), float(recall)

    return asyncio.run(score())
