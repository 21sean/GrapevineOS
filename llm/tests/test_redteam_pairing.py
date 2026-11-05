"""The red team's result mapping, without PyRIT installed."""
import importlib.util
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("pairing", ROOT / "server/redteam/pairing.py")
pairing = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pairing)

BATCH = [{"id": name, "strategy": "crescendo", "objective": f"objective {name}"} for name in "abc"]


def test_a_dead_attack_does_not_shift_later_verdicts():
    executed = SimpleNamespace(completed_results=["verdict c"], input_indices=[2],
                               incomplete_objectives=[("objective a", RuntimeError("boom a")),
                                                      ("objective b", RuntimeError("boom b"))])
    assert pairing.pair_results(BATCH, executed) == [(BATCH[2], "verdict c")]
    rows = pairing.unfinished(BATCH, executed)
    assert [row["id"] for row in rows] == ["a", "b"]
    assert [row["error"] for row in rows] == ["boom a", "boom b"]
    assert all(row["outcome"] == "error" and row["turns"] == [] for row in rows)


def test_every_attack_finishing_reports_nothing_unfinished():
    executed = SimpleNamespace(completed_results=[1, 2, 3], input_indices=[0, 1, 2],
                               incomplete_objectives=[])
    assert [spec["id"] for spec, _ in pairing.pair_results(BATCH, executed)] == ["a", "b", "c"]
    assert pairing.unfinished(BATCH, executed) == []
