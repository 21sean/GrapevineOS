import copy
import json

import pytest
from pydantic import ValidationError

from grapevine_llm import pins, profiles
from grapevine_llm.checks import BASELINE, complete, no_regression
from grapevine_llm.client import Message, Request, build_payload, generate, vllm_transport
from grapevine_llm.evals import Report
from grapevine_llm.pins import active_manifest
from grapevine_llm.profiles import UNPROFILED, ModelProfile, path_of, profile_for, request_for, reviewed
from grapevine_llm.provenance import capture, digest, model_records
from grapevine_llm.settings import Settings
from test_vllm import Fake, payload

QWEN = json.loads((profiles.DIR / "qwen3.8.json").read_text(encoding="utf-8"))
CLAUDE = json.loads((profiles.DIR / "claude-fable-5.2.json").read_text(encoding="utf-8"))
RUNTIMES = ("ollama", "vllm", "triton")


def changed(**parts) -> dict:
    """The committed Qwen profile with some of its parts replaced."""
    doc = copy.deepcopy(QWEN)
    for key, value in parts.items():
        doc[key] = {**doc[key], **value} if isinstance(value, dict) else value
    return doc


@pytest.fixture
def use(tmp_path, monkeypatch):
    """Load profiles from a scratch directory in place of the committed ones."""
    def install(*docs):
        for doc in docs:
            (tmp_path / f"{doc['family']}.json").write_text(json.dumps(doc), encoding="utf-8")
        monkeypatch.setattr(profiles, "DIR", tmp_path)
        profiles.profiles.cache_clear()

    yield install
    profiles.profiles.cache_clear()


def test_committed_profiles_are_valid_and_named_for_their_family():
    found = profiles.profiles()
    assert {p.family for p in found} == {path.stem for path in profiles.DIR.glob("*.json")}
    assert {p.family: p.status for p in found} == {"qwen3.8": "reviewed", "claude-fable-5.2": "imported"}


@pytest.mark.parametrize("runtime", RUNTIMES)
def test_every_pinned_model_has_a_reviewed_profile(runtime):
    pins, profile = active_manifest(runtime), reviewed(runtime)
    assert profile is profile_for(runtime, pins.generation.name) is profile_for(runtime, pins.judge.name)
    assert profile.request.temperature == pins.temperature
    assert (profile.request.thinking, profile.gates.judge_score_min) == (False, 0.75)
    for departure in profile.departures:
        assert departure.evidence is None or (profiles.ROOT / departure.evidence).is_file()


def test_the_gate_sends_what_the_profile_says(use):
    use(changed(request={"temperature": 0.7, "thinking": True}))
    sent = build_payload(Settings(), {"type": "object"}, [{"role": "user", "content": "hi"}])
    assert (sent["think"], sent["options"]["temperature"], sent["options"]["seed"]) == (True, 0.7, 42)


def test_the_committed_profile_keeps_the_request_the_gate_always_sent():
    sent = build_payload(Settings(), {"type": "object"}, [{"role": "user", "content": "hi"}])
    assert (sent["think"], sent["options"]["temperature"]) == (False, 0)
    assert request_for("ollama", "qwen3.8:27b") == UNPROFILED


def test_a_model_without_a_profile_gets_the_gate_defaults():
    assert profile_for("ollama", "gemma4:31b") is None
    assert request_for("ollama", "gemma4:31b") is UNPROFILED
    # A profile governs a model on the runtimes it names, and nowhere else.
    assert profile_for("ollama", "qwen3.8-27b-int4") is None
    sent = build_payload(Settings(model="gemma4:31b"), {"type": "object"}, [{"role": "user", "content": "hi"}])
    assert (sent["think"], sent["options"]["temperature"]) == (False, 0)


def test_vllm_takes_the_thinking_switch_and_the_system_rule_from_the_family(use):
    messages = [{"role": "user", "content": "one"}, {"role": "system", "content": "late"}]
    with Fake() as fake:
        vllm_transport(fake.url, 100_000)({**payload(), "messages": messages}, 5)
    assert fake.requests[0]["chat_template_kwargs"] == {"enable_thinking": False}
    assert [m["role"] for m in fake.requests[0]["messages"]] == ["system", "user"]

    use(changed(request={"thinking_template_kwarg": None, "single_system_message": False}))
    with Fake() as fake:
        vllm_transport(fake.url, 100_000)({**payload(), "messages": messages}, 5)
    assert "chat_template_kwargs" not in fake.requests[0]
    assert fake.requests[0]["messages"] == messages


def test_thresholds_come_from_the_profile(use, monkeypatch):
    monkeypatch.delenv("GRAPEVINE_LLM_RUNTIME", raising=False)
    report = Report.model_validate_json(BASELINE.read_bytes())
    complete(report)
    use(changed(gates={"faithfulness_floor": 0.99}))
    with pytest.raises(ValueError, match="average faithfulness below 0.99"):
        complete(report)
    use(changed(gates={"judge_score_min": 1.0}))
    next(r for r in report.results if r.id == "grounded-jazz").judge_score = 0.9
    with pytest.raises(ValueError, match="failing judge: grounded-jazz"):
        complete(report)
    # The allowed drop in average faithfulness is the profile's too.
    before, after = (Report.model_validate_json(BASELINE.read_bytes()) for _ in range(2))
    after.retrieval.faithfulness = before.retrieval.faithfulness - 0.1
    use(changed())
    no_regression(after, before)
    use(changed(gates={"faithfulness_drop": 0.05}))
    with pytest.raises(ValueError, match="average faithfulness"):
        no_regression(after, before)


def test_no_reviewed_profile_is_a_failure(use, monkeypatch):
    monkeypatch.delenv("GRAPEVINE_LLM_RUNTIME", raising=False)
    use(CLAUDE)
    with pytest.raises(ValueError, match="no reviewed profile for qwen3.8:27b on ollama"):
        reviewed("ollama")
    with pytest.raises(ValueError, match="no reviewed profile"):
        complete(Report.model_validate_json(BASELINE.read_bytes()))
    # Requests still go out, with the defaults: only the gates need the evidence.
    assert request_for("ollama", "qwen3.8:27b") is UNPROFILED


def test_a_profile_that_does_not_load_stops_generation_as_a_configuration_fault(use, tmp_path):
    request = Request(id="test", task="rating", messages=[Message(role="user", content="Rate jazz")])
    answer = json.dumps({"rating": 4, "rationale": "local", "promoted": False})
    assert generate(request, Settings(), transport=lambda payload, remaining: answer).ok
    use()
    (tmp_path / "qwen3.8.json").write_text("{}", encoding="utf-8")
    result = generate(request, Settings(), transport=lambda payload, remaining: answer)
    assert (result.ok, result.code, result.stats.attempts) == (False, "configuration", 0)


def test_a_profile_must_agree_with_the_manifest_and_keep_its_evidence(use):
    use(changed(request={"temperature": 0.7}))
    with pytest.raises(ValueError, match="disagree on temperature"):
        reviewed("vllm")
    missing = changed()
    missing["departures"][1]["evidence"] = "llm/bench/experiments/gone.json"
    use(missing)
    with pytest.raises(ValueError, match="missing evidence: llm/bench/experiments/gone.json"):
        reviewed("vllm")


def test_the_judge_must_be_governed_by_the_generation_profile(use, monkeypatch):
    other = changed(family="other", served=[{"runtime": "ollama", "model": "qwen3.8:27b"}])
    use(changed(served=[{"runtime": "ollama", "model": "another:1b"}]), other)
    assert reviewed("ollama").family == "other"
    manifest = active_manifest("ollama").model_copy(deep=True)
    manifest.judge.name = "another:1b"
    monkeypatch.setattr(pins, "active_manifest", lambda runtime: manifest)
    with pytest.raises(ValueError, match="the judge another:1b is not governed by the other profile"):
        reviewed("ollama")


def test_two_profiles_cannot_claim_one_model_and_a_file_is_named_for_its_family(use, tmp_path):
    use(changed(), changed(family="copy"))
    with pytest.raises(ValueError, match="claimed by copy and qwen3.8"):
        profiles.profiles()
    (tmp_path / "copy.json").unlink()
    (tmp_path / "qwen3.8.json").rename(tmp_path / "renamed.json")
    profiles.profiles.cache_clear()
    with pytest.raises(ValueError, match="named for its family: renamed.json"):
        profiles.profiles()


@pytest.mark.parametrize("doc,why", [
    (changed(status="imported"), "sourced facts only"),
    ({**CLAUDE, "gates": QWEN["gates"]}, "sourced facts only"),
    ({**CLAUDE, "served": [{"runtime": "ollama", "model": "claude"}]}, "sourced facts only"),
    (changed(gates=None), "names its models, request settings and gates"),
    (changed(served=[]), "names its models, request settings and gates"),
    (changed(facts=[{"name": "x", "value": 1, "source": "nowhere"}]), "unknown source: nowhere"),
    (changed(facts=[{"name": "x", "value": 1, "source": "card"}] * 2), "fact names must be unique"),
    (changed(sources=QWEN["sources"][:1] * 2), "source IDs must be unique"),
    (changed(served=QWEN["served"][:1] * 2), "served models must be unique"),
])
def test_the_contract_refuses_an_incoherent_profile(doc, why):
    with pytest.raises(ValidationError, match=why):
        ModelProfile.model_validate(doc)


def test_a_source_is_an_https_link_with_a_date():
    for bad in ({"url": "http://example.com"}, {"retrieved": "yesterday"}, {"retrieved": "2026-13-01"}):
        doc = changed(sources=[{**QWEN["sources"][0], **bad}, *QWEN["sources"][1:]])
        with pytest.raises(ValidationError):
            ModelProfile.model_validate(doc)


def test_an_import_states_what_blocks_a_pinned_run():
    claude = next(p for p in profiles.profiles() if p.family == "claude-fable-5.2")
    facts = {f.name: f.value for f in claude.facts}
    # The gates rest on temperature 0. This family's API refuses a temperature.
    assert facts["accepts_temperature"] is False
    assert {f.source for f in claude.facts} == {"models-dev"}
    assert (claude.request, claude.gates, claude.served) == (None, None, [])


@pytest.mark.parametrize("runtime", RUNTIMES)
def test_provenance_covers_the_profile(runtime, monkeypatch):
    monkeypatch.setenv("GRAPEVINE_LLM_RUNTIME", runtime)
    records = model_records(runtime)
    assert path_of(reviewed(runtime)) in records and len(records) == 2
    assert capture(16384, 3).models_sha256 == digest(records) != digest(records[:1])
