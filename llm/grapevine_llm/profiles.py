"""
One reviewed record per model family: how the gate asks it, what its evals must
clear, and what its publisher says, each with a source.

A profile is either reviewed or imported. A reviewed profile names the models it
governs, and its request settings and gate thresholds are read by the code that
sends requests and judges results, so they are enforced, not described. An imported
profile holds facts taken from a public catalog and nothing measured here; the eval
gates refuse to run against it.
"""
from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import Annotated, Literal

from pydantic import Field, model_validator

from .contracts import Contract, Day, Id, Score, Short, Text

ROOT = Path(__file__).resolve().parents[2]
DIR = ROOT / "llm/evals/profiles"

Runtime = Literal["ollama", "vllm", "triton"]
RepoPath = Annotated[str, Field(pattern=r"^[A-Za-z0-9_][A-Za-z0-9_./-]*$", max_length=200)]
Url = Annotated[str, Field(pattern=r"^https://[^\s]+$", max_length=300)]


class Source(Contract):
    id: Id
    name: Short
    url: Url
    retrieved: Day
    # The attribution the source's terms ask for, where they ask for one.
    credit: Short | None = None


class Served(Contract):
    runtime: Runtime
    model: Annotated[str, Field(min_length=1, max_length=150)]


class RequestSettings(Contract):
    """What the gate sends for this family. client.py builds every request from these."""

    temperature: Annotated[float, Field(ge=0, le=2)]
    thinking: bool
    # The chat-template keyword vLLM takes to switch thinking, or None if the family has none.
    thinking_template_kwarg: Short | None
    # The family's chat template refuses a system message that is not first.
    single_system_message: bool


class Gates(Contract):
    """Thresholds measured with this family as both the generator and the judge."""

    judge_score_min: Score
    faithfulness_floor: Score
    faithfulness_drop: Score
    first_pass_rate_min: Score
    # What the thresholds were set from, in a sentence a reviewer can check.
    calibration: Text


class Fact(Contract):
    """Something a source states about the family. Recorded, never enforced."""

    name: Id
    value: str | int | float | bool | list[Short]
    source: Id


class Departure(Contract):
    """Where this deployment does something other than what the publisher says."""

    setting: Short
    publisher: Text
    here: Text
    reason: Text
    source: Id
    # The committed result that measured the difference. None means it was not measured.
    evidence: RepoPath | None = None


class ModelProfile(Contract):
    family: Id
    name: Short
    publisher: Short
    status: Literal["reviewed", "imported"]
    served: Annotated[list[Served], Field(max_length=20)]
    request: RequestSettings | None = None
    gates: Gates | None = None
    sources: Annotated[list[Source], Field(min_length=1, max_length=20)]
    facts: Annotated[list[Fact], Field(max_length=60)]
    departures: Annotated[list[Departure], Field(max_length=20)] = []

    @model_validator(mode="after")
    def coherent(self):
        sources = [s.id for s in self.sources]
        if len(set(sources)) != len(sources):
            raise ValueError("source IDs must be unique")
        if len({f.name for f in self.facts}) != len(self.facts):
            raise ValueError("fact names must be unique")
        if len({(s.runtime, s.model) for s in self.served}) != len(self.served):
            raise ValueError("served models must be unique")
        for used in [f.source for f in self.facts] + [d.source for d in self.departures]:
            if used not in sources:
                raise ValueError(f"unknown source: {used}")
        if self.status == "reviewed":
            if not self.served or self.request is None or self.gates is None:
                raise ValueError("a reviewed profile names its models, request settings and gates")
        elif self.served or self.request is not None or self.gates is not None or self.departures:
            raise ValueError("an imported profile holds sourced facts only")
        return self


# What the gate sent before profiles existed. A model without a reviewed profile still
# gets exactly this, so picking one in Admin behaves as it always has.
UNPROFILED = RequestSettings(temperature=0, thinking=False,
                             thinking_template_kwarg="enable_thinking", single_system_message=True)


def path_of(profile: ModelProfile) -> Path:
    return DIR / f"{profile.family}.json"


@lru_cache(maxsize=1)
def profiles() -> tuple[ModelProfile, ...]:
    """Every committed profile. A file must be named for its family, and no two may claim a model."""
    found: list[ModelProfile] = []
    claimed: dict[tuple[str, str], str] = {}
    for path in sorted(DIR.glob("*.json")):
        profile = ModelProfile.model_validate_json(path.read_text(encoding="utf-8"))
        if path != path_of(profile):
            raise ValueError(f"profile file must be named for its family: {path.name}")
        for served in profile.served:
            key = (served.runtime, served.model)
            if key in claimed:
                raise ValueError(f"{served.model} on {served.runtime} is claimed by {claimed[key]} and {profile.family}")
            claimed[key] = profile.family
        found.append(profile)
    return tuple(found)


def profile_for(runtime: str, model: str) -> ModelProfile | None:
    """The reviewed profile that governs this model on this runtime, by exact name."""
    for profile in profiles():
        if any(s.runtime == runtime and s.model == model for s in profile.served):
            return profile
    return None


def request_for(runtime: str, model: str) -> RequestSettings:
    profile = profile_for(runtime, model)
    return profile.request if profile and profile.request else UNPROFILED


def reviewed(runtime: str) -> ModelProfile:
    """
    The profile the eval gates run under: the one that governs the runtime's pinned
    generation model. The judge must be governed by it too, because the thresholds
    were measured with one family doing both jobs. No profile is a failure.
    """
    from .pins import active_manifest

    pins = active_manifest(runtime)
    profile = profile_for(runtime, pins.generation.name)
    if profile is None or profile.request is None or profile.gates is None:
        raise ValueError(f"no reviewed profile for {pins.generation.name} on {runtime}")
    if profile_for(runtime, pins.judge.name) is not profile:
        raise ValueError(f"the judge {pins.judge.name} is not governed by the {profile.family} profile")
    if profile.request.temperature != pins.temperature:
        raise ValueError(f"the {profile.family} profile and the {runtime} manifest disagree on temperature")
    for departure in profile.departures:
        if departure.evidence and not (ROOT / departure.evidence).is_file():
            raise ValueError(f"missing evidence: {departure.evidence}")
    return profile


def gates(runtime: str) -> Gates:
    return reviewed(runtime).gates
