"""
Line PyRIT's executor results back up with the objectives that produced them.

Pure and import-free so a unit test can load it without installing PyRIT.

PyRIT 1.0.1 reports `completed_results` only for the attacks that finished,
`input_indices` for where each one came from, and `incomplete_objectives` as
(objective text, exception) pairs. A plain zip over the batch would hand the
second objective's verdict to the first as soon as the first one died.
"""

from __future__ import annotations

from typing import Any


def pair_results(batch: list[dict[str, Any]], executed: Any) -> list[tuple[dict[str, Any], Any]]:
    """(spec, result) for every attack that finished, by original position."""
    return [
        (batch[index], result)
        for index, result in zip(executed.input_indices, executed.completed_results, strict=True)
    ]


def unfinished(batch: list[dict[str, Any]], executed: Any) -> list[dict[str, Any]]:
    """A row per attack that died, in the shape the harness reports."""
    done = set(executed.input_indices)
    rows = []
    failures = iter(executed.incomplete_objectives)
    for index, spec in enumerate(batch):
        if index in done:
            continue
        _, error = next(failures, (None, None))
        rows.append(
            {
                "id": spec["id"],
                "strategy": spec["strategy"],
                "objective": spec["objective"],
                "outcome": "error",
                "outcome_reason": "the attack did not finish",
                "executed_turns": 0,
                "score": None,
                "turns": [],
                "error": str(error)[:600] if error is not None else "incomplete",
            }
        )
    return rows
