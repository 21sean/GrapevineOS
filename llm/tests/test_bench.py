import json

import pytest

from grapevine_llm import bench
from grapevine_llm.bench import (BASELINES, RESULTS, BenchReport, Hardware, Incomparable, Level, Percentiles, Sample,
                                 ServedModel, Workload, check, compare, evidence, load, one_request, percentile,
                                 provenance_table, question, summarize, table)
from grapevine_llm.settings import Settings


def three(p50, p95=None, p99=None, n=48):
    p95 = p50 * 1.4 if p95 is None else p95
    return Percentiles(n=n, p50=p50, p95=p95, p99=p95 * 1.1 if p99 is None else p99)


def level(prompt="short", streams=4, ttft=150.0, tpot=12.0, e2e=3000.0, tps=200.0, errors=0, invalid=0, n=48, **over):
    fields = dict(prompt=prompt, streams=streams, requests=n, errors=errors, invalid=invalid,
                  ttft_ms=three(ttft, n=n), tpot_ms=three(tpot, n=n), e2e_ms=three(e2e, n=n),
                  stream_tokens_per_s=three(1000 / tpot, n=n), total_tokens_per_s=tps,
                  prompt_tokens=three(437, n=n), output_tokens=three(120, n=n), cached_prompt_share=0.0, wall_s=30.0)
    return Level(**{**fields, **over})


def report(levels=None, driver="621.14", **model):
    served = {"runtime": "vllm", "runtime_version": "0.33.0", "name": "qwen3.8-27b-int4",
              "quantization": "W4A16 INT4", "source": "RedHatAI/Qwen3.8-27B-INT4@91bd022d", "pinned": True, **model}
    return BenchReport(created="2026-11-18T16:00:00+00:00", revision="0" * 40,
                       hardware=Hardware(gpu="NVIDIA GeForce RTX 5090", gpu_memory_mib=32607, driver=driver,
                                         cuda="13.5", cpu="test cpu", os="test os"),
                       model=ServedModel(**served),
                       workload=Workload(max_tokens=256, num_ctx=16384, seed=42, requests=48, warmup=2),
                       levels=levels or [level()])


def test_percentiles_are_values_that_were_observed():
    values = [float(v) for v in range(1, 101)]
    assert [percentile(values, p) for p in (50, 95, 99)] == [50.0, 95.0, 99.0]
    # Nearest rank never interpolates between two samples.
    assert percentile([10.0, 20.0], 50) == 10.0
    assert percentile([3.0, 1.0, 2.0], 50) == 2.0
    assert percentile([5.0], 99) == 5.0
    assert percentile([], 50) is None


def test_the_workload_is_fixed_and_no_request_can_hit_a_cached_question():
    assert len(evidence("short")) == 3
    assert len(evidence("long")) == 35
    assert evidence("long") == evidence("long")
    first, second = question("short", 1), question("short", 2)
    assert first.startswith("Request 1.") and second.startswith("Request 2.")
    assert first.removeprefix("Request 1.") == second.removeprefix("Request 2.")


def test_summary_counts_failures_apart_from_timings():
    samples = [
        Sample(valid=True, ttft_ms=100, tpot_ms=10, e2e_ms=1000, prompt_tokens=400, cached_prompt_tokens=100, output_tokens=90),
        Sample(valid=True, ttft_ms=200, tpot_ms=20, e2e_ms=2000, prompt_tokens=400, cached_prompt_tokens=300, output_tokens=110),
        Sample(valid=False, ttft_ms=300, tpot_ms=40, e2e_ms=3000, prompt_tokens=400, cached_prompt_tokens=0, output_tokens=50),
        Sample(error="TimeoutError"),
    ]
    lv = summarize("short", 2, samples, wall_s=5.0)
    assert (lv.requests, lv.errors, lv.invalid) == (4, 1, 1)
    # The failed request has no timings and is not averaged in as a zero.
    assert (lv.ttft_ms.n, lv.ttft_ms.p50, lv.ttft_ms.p99) == (3, 200, 300)
    assert lv.stream_tokens_per_s.p50 == 50
    assert lv.total_tokens_per_s == (90 + 110 + 50) / 5.0
    assert lv.cached_prompt_share == pytest.approx(400 / 1200)


def transport(reply):
    def build(base, max_bytes, log):
        def send(payload, remaining):
            log()
            if isinstance(reply, Exception):
                raise reply
            return reply
        return send
    return {"ollama": build}


def test_a_request_that_fails_is_recorded_not_raised():
    cited = evidence("short")[0].id
    good = json.dumps({"kind": "answer", "answer": "Shoreline Jazz is free.", "citations": [cited], "tool_calls": []})
    made_up = json.dumps({"kind": "answer", "answer": "Shoreline Jazz is free.", "citations": ["not-supplied"], "tool_calls": []})
    assert one_request(Settings(), "short", 0, 64, 5, transport(good)).valid is True
    wrong = one_request(Settings(), "short", 0, 64, 5, transport(made_up))
    assert (wrong.error, wrong.valid) == (None, False)
    failed = one_request(Settings(), "short", 0, 64, 5, transport(TimeoutError("deadline")))
    assert (failed.error, failed.valid, failed.e2e_ms) == ("TimeoutError", False, None)


def test_the_same_numbers_and_better_numbers_pass():
    assert compare(report(), report()) == ([], [])
    faster = report([level(ttft=100.0, tpot=9.0, e2e=2000.0, tps=260.0)])
    assert compare(report(), faster) == ([], [])


@pytest.mark.parametrize("change,expected", [
    ({"ttft": 230.0}, "ttft_ms p50 150.0 -> 230.0 ms"),
    ({"tpot": 15.0}, "tpot_ms p50 12.0 -> 15.0 ms"),
    ({"e2e": 3600.0}, "e2e_ms p50 3000.0 -> 3600.0 ms"),
    ({"tps": 160.0}, "throughput 200 -> 160 tok/s"),
    ({"errors": 1}, "1 errors and 0 invalid answers"),
    ({"invalid": 2}, "0 errors and 2 invalid answers"),
])
def test_a_slower_or_less_correct_run_is_a_regression(change, expected):
    regressions, _ = compare(report(), report([level(**change)]))
    assert any(expected in r for r in regressions), regressions


def test_noise_under_the_floor_and_inside_the_band_is_not_a_regression():
    # +20% on a 5 ms token time is 1 ms: past the percentage, under the absolute floor.
    assert compare(report([level(tpot=5.0)]), report([level(tpot=6.0)]))[0] == []
    # +10% is inside the 15% band however large it is in milliseconds.
    assert compare(report([level(e2e=10_000.0)]), report([level(e2e=11_000.0)]))[0] == []
    # Throughput may fall 15% before it counts.
    assert compare(report(), report([level(tps=171.0)]))[0] == []


def test_first_token_time_gets_a_wide_band_only_where_it_does_not_repeat():
    # +27% is inside the band at 4 streams, where identical runs differ that much...
    assert compare(report(), report([level(ttft=190.0)]))[0] == []
    # ...and outside it at one stream, where they do not.
    regressions, _ = compare(report([level(streams=1)]), report([level(streams=1, ttft=190.0)]))
    assert any("short x1: ttft_ms p50 150.0 -> 190.0 ms (+27%, limit 15%)" in r for r in regressions)


def test_the_tail_is_gated_only_with_enough_samples_to_mean_something():
    def tail(p99, n):
        return report([level(n=n, ttft_ms=Percentiles(n=n, p50=150.0, p95=200.0, p99=p99))])
    assert compare(tail(220.0, 48), tail(900.0, 48))[0] == []
    regressions, _ = compare(tail(220.0, 120), tail(900.0, 120))
    assert any("ttft_ms p99" in r for r in regressions)


def test_a_missing_level_is_a_regression_and_a_new_driver_is_a_note():
    baseline = report([level(streams=1), level(streams=4)])
    regressions, notes = compare(baseline, report([level(streams=1)], driver="630.02"))
    assert regressions == ["short x4: level missing from the result"]
    assert notes == ["driver 621.14 -> 630.02"]


@pytest.mark.parametrize("change", [{"quantization": "Q4_K_M GGUF"}, {"runtime_version": "0.34.0"},
                                    {"source": "RedHatAI/Qwen3.8-27B-INT4@other"}, {"pinned": False}])
def test_runs_of_different_things_are_refused_not_compared(change):
    with pytest.raises(Incomparable):
        compare(report(), report(**change))


def test_the_gate_needs_a_result_and_a_baseline_for_it(tmp_path):
    results, baselines = tmp_path / "results", tmp_path / "baseline"
    results.mkdir()
    baselines.mkdir()
    assert any("no benchmark results" in f for f in check(results, baselines))
    (results / "vllm.json").write_text(report().model_dump_json(), encoding="utf-8")
    assert check(results, baselines) == ["vllm.json: no stored baseline"]
    (baselines / "vllm.json").write_text(report().model_dump_json(), encoding="utf-8")
    assert check(results, baselines) == []
    (results / "vllm.json").write_text(report([level(ttft=400.0)]).model_dump_json(), encoding="utf-8")
    assert any("vllm.json: short x4: ttft_ms p50" in f for f in check(results, baselines))
    (results / "vllm.json").write_text(report(quantization="other").model_dump_json(), encoding="utf-8")
    assert any("not comparable" in f for f in check(results, baselines))


def test_the_base_branch_baseline_cannot_be_edited_away(tmp_path, monkeypatch):
    results, baselines = tmp_path / "results", tmp_path / "baseline"
    results.mkdir()
    baselines.mkdir()
    slow = report([level(ttft=400.0)])
    # The pull request slows the runtime and replaces the baseline with the slow run.
    (results / "vllm.json").write_text(slow.model_dump_json(), encoding="utf-8")
    (baselines / "vllm.json").write_text(slow.model_dump_json(), encoding="utf-8")
    assert check(results, baselines) == []
    monkeypatch.setattr(bench, "git_blob", lambda ref, path: report().model_dump_json().encode())
    failures = check(results, baselines, base_ref="origin/main")
    assert any("against origin/main" in f and "ttft_ms p50" in f for f in failures)
    # A reviewed re-pin changes what is being measured: the old baseline no longer applies.
    monkeypatch.setattr(bench, "git_blob", lambda ref, path: report(runtime_version="0.32.0").model_dump_json().encode())
    assert check(results, baselines, base_ref="origin/main") == []
    # The first rollout has no baseline on the base branch at all.
    monkeypatch.setattr(bench, "git_blob", lambda ref, path: None)
    assert check(results, baselines, base_ref="origin/main") == []


def test_the_tables_carry_what_was_measured_and_on_what():
    text = provenance_table([report()]) + table([report()])
    for expected in ("vLLM", "0.33.0", "W4A16 INT4", "NVIDIA GeForce RTX 5090 (32607 MiB)", "621.14", "13.5",
                     "150/210/231", "12.0/16.8/18.5"):
        assert expected in text


def test_a_run_on_changed_measurement_code_says_so(monkeypatch):
    calls = {"rev-parse": "a" * 40 + "\n", "status": ""}
    monkeypatch.setattr(bench.subprocess, "check_output", lambda cmd, **_: calls[cmd[1]])
    assert bench.revision() == "a" * 40
    calls["status"] = " M llm/grapevine_llm/client.py\n"
    assert bench.revision() == "a" * 40 + "-dirty"
    assert "(uncommitted changes)" in provenance_table([report().model_copy(update={"revision": bench.revision()})])


def test_every_committed_result_is_pinned_and_passes_against_its_baseline():
    files = sorted(RESULTS.glob("*.json"))
    assert {f.stem for f in files} == {"ollama", "triton", "vllm"}
    for path in files:
        result = load(path)
        assert result.model.pinned and result.model.runtime == path.stem
        assert not result.revision.endswith("-dirty")
        assert result.model.quantization and result.hardware.driver and result.hardware.gpu
        assert all(lv.errors == 0 for lv in result.levels)
        assert (BASELINES / path.name).exists()
    assert check() == []
