"""Version 1 contracts. Context is supplied by trusted application code, never the model."""
from __future__ import annotations

import json
import re
from datetime import datetime
from typing import Annotated, Literal, Self, Union
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, ValidationInfo, create_model, model_validator

VERSION = "1.0.0"
Text = Annotated[str, Field(min_length=1, max_length=2000)]
Short = Annotated[str, Field(min_length=1, max_length=200)]
Id = Annotated[str, Field(min_length=1, max_length=200, pattern=r"^[a-zA-Z0-9_.:-]+$")]
Category = Literal["music", "food", "sports", "arts", "market", "festival", "community"]
Rarity = Literal["common", "notable", "rare"]
Rating = Annotated[float, Field(ge=1, le=5)]
Score = Annotated[float, Field(ge=0, le=1)]
Tags = Annotated[list[Short], Field(max_length=6)]
Ids = Annotated[list[Id], Field(min_length=1, max_length=30)]
Day = Annotated[str, Field(pattern=r"^\d{4}-\d{2}-\d{2}$")]
Coordinate = tuple[Annotated[float, Field(ge=-180, le=180)], Annotated[float, Field(ge=-90, le=90)]] | Annotated[str, Field(pattern=r"^\s*-?\d+(\.\d+)?\s*,\s*-?\d+(\.\d+)?\s*$", max_length=80)]


class Contract(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, allow_inf_nan=False, validate_default=True)


class Evidence(Contract):
    id: Id
    text: Annotated[str, Field(max_length=200_000)]


class Context(Contract):
    event_ids: Annotated[list[Id], Field(max_length=20_000)] = []
    candidate_count: Annotated[int, Field(ge=0, le=200)] = 0
    evidence: Annotated[list[Evidence], Field(max_length=200)] = []
    allowed_tools: Annotated[list[Short], Field(max_length=30)] = []
    require_citations: bool = False


def context(info: ValidationInfo) -> Context:
    value = (info.context or {}).get("request")
    if not isinstance(value, Context):
        raise ValueError("trusted validation context is required")
    return value


def timestamp(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("timestamps require an explicit timezone")
    return parsed


class Event(Contract):
    title: Short
    description: Annotated[str, Field(max_length=4000)]
    category: Category
    tags: Tags
    venue: Short
    address: Annotated[str, Field(max_length=500)]
    start: Short
    end: Short
    recurrence: Annotated[str, Field(max_length=300)] | None
    price: Short
    free: bool
    ticketUrl: Annotated[str, Field(max_length=2000)] | None
    ticketProvider: Short | None
    buzz: Rating
    buzzWhy: Text
    promoted: bool
    rarity: Rarity

    @model_validator(mode="after")
    def facts(self) -> Self:
        if timestamp(self.end) <= timestamp(self.start):
            raise ValueError("end must follow start")
        if self.free and self.price.casefold() not in {"free", "$0", "$0.00", "0"}:
            raise ValueError("free and price disagree")
        if self.ticketUrl:
            url = urlsplit(self.ticketUrl)
            if url.scheme not in {"https", "http"} or not url.hostname or url.username:
                raise ValueError("ticket URL must be an absolute http(s) URL without credentials")
        if self.recurrence and not re.fullmatch(r"FREQ=(DAILY|WEEKLY|MONTHLY|YEARLY)(;[A-Z]+=[A-Z0-9,+-]+)*", self.recurrence):
            raise ValueError("invalid recurrence syntax")
        return self


class Extraction(Contract):
    events: Annotated[list[Event], Field(max_length=200)]


class EventRating(Contract):
    rating: Rating
    rationale: Text
    promoted: bool


class Label(Contract):
    index: Annotated[int, Field(ge=0, le=199)]
    category: Category
    tags: Tags
    buzz: Rating
    buzzWhy: Text
    promoted: bool
    rarity: Rarity


class Enrichment(Contract):
    labels: Annotated[list[Label], Field(max_length=200)]

    @model_validator(mode="after")
    def complete(self, info: ValidationInfo) -> Self:
        if sorted(x.index for x in self.labels) != list(range(context(info).candidate_count)):
            raise ValueError("return every candidate index exactly once")
        return self


class Verdict(Contract):
    index: Annotated[int, Field(ge=0, le=199)]
    verdict: Literal["confirmed", "corrected", "unsupported"]
    confidence: Score
    evidence: Annotated[str, Field(max_length=500)]
    start: Short | None
    end: Short | None
    venue: Short | None
    price: Short | None

    @model_validator(mode="after")
    def supported(self, info: ValidationInfo) -> Self:
        source = "\n".join(e.text for e in context(info).evidence)
        if self.verdict != "unsupported" and (not self.evidence.strip() or self.evidence not in source):
            raise ValueError("supported verdict requires a verbatim source quote")
        if self.start:
            timestamp(self.start)
        if self.end:
            timestamp(self.end)
        if self.start and self.end and timestamp(self.end) <= timestamp(self.start):
            raise ValueError("corrected end must follow start")
        if self.verdict == "corrected" and not any((self.start, self.end, self.venue, self.price)):
            raise ValueError("corrected verdict requires a correction")
        return self


class Verification(Contract):
    verdicts: Annotated[list[Verdict], Field(max_length=200)]

    @model_validator(mode="after")
    def complete(self, info: ValidationInfo) -> Self:
        if sorted(x.index for x in self.verdicts) != list(range(context(info).candidate_count)):
            raise ValueError("return every candidate index exactly once")
        return self


class Summary(Contract):
    summary: Text


class JudgeScore(Contract):
    score: Score
    reason: Text


class SearchEvents(Contract):
    query: Short | None = None
    categories: list[Category] | None = None
    tags: Tags | None = None
    date_from: Day | None = None
    date_to: Day | None = None
    free_only: bool | None = None
    min_rating: Rating | None = None
    exclude_promoted: bool | None = None
    near: Short | None = None
    max_km: Annotated[float, Field(gt=0, le=500)] | None = None
    sort: Literal["time", "buzz", "distance"] | None = None
    limit: Annotated[int, Field(ge=1, le=50)] | None = None


class GetEvent(Contract):
    id: Id


class EventIds(Contract):
    event_ids: Ids


class EventId(Contract):
    event_id: Id


class GetEta(Contract):
    to_event_id: Id | None = None
    to: Coordinate | None = None
    from_: Coordinate | None = Field(default=None, alias="from")

    @model_validator(mode="after")
    def destination(self) -> Self:
        if bool(self.to_event_id) == bool(self.to):
            raise ValueError("provide exactly one of to_event_id or to")
        return self


class SearchWeb(Contract):
    query: Short
    limit: Annotated[int, Field(ge=1, le=8)] | None = None


class ReadPage(Contract):
    url: Annotated[str, Field(pattern=r"^https?://[^\s]+$", max_length=2000)]


class Discover(Contract):
    query: Annotated[str, Field(min_length=3, max_length=200)]
    dry_run: bool | None = None


class Calendar(EventIds):
    note: Short | None = None


class Schedule(Contract):
    query: Annotated[str, Field(min_length=3, max_length=200)]
    cadence_hours: Annotated[float, Field(ge=1, le=336)] | None = None


class Watch(Schedule):
    note: Short | None = None


class UpdateSchedule(Contract):
    id: Id
    active: bool | None = None
    cadence_hours: Annotated[float, Field(ge=1, le=336)] | None = None


class UnSchedule(Contract):
    id: Id | None = None
    query: Short | None = None


class Interests(Contract):
    reason: Short | None = None
    add_loves: Tags | None = None
    add_avoids: Tags | None = None
    remove_loves: Tags | None = None
    remove_avoids: Tags | None = None


class ApplyInterests(Interests):
    confirmed: Literal[True]


class SetRarity(EventId):
    rarity: Rarity


class SetFilters(Contract):
    reset: bool | None = None
    categories: list[Category] | None = None
    live_only: bool | None = None
    rare_only: bool | None = None
    free_only: bool | None = None
    farmers: Literal["any", "only", "hide"] | None = None
    hide_promoted: bool | None = None
    min_buzz: Annotated[float, Field(ge=0, le=5)] | None = None
    date_from: Day | None = None
    date_to: Day | None = None
    note: Short | None = None


TOOL_ARGS: dict[str, type[Contract]] = {
    "search_events": SearchEvents, "get_event": GetEvent, "get_eta": GetEta,
    "search_web": SearchWeb, "read_page": ReadPage, "discover_events": Discover,
    "show_on_map": EventIds, "set_filters": SetFilters, "propose_calendar": Calendar,
    "propose_watch": Watch, "save_calendar": EventIds, "list_saved_events": Contract,
    "save_event": EventId, "unsave_event": EventId, "set_rarity": SetRarity,
    "update_interests": Interests, "apply_interests": ApplyInterests,
    "list_scheduled_searches": Contract, "schedule_search": Schedule,
    "update_scheduled_search": UpdateSchedule, "run_scheduled_search": GetEvent,
    "unschedule_search": UnSchedule,
}


class ToolCallBase(Contract):
    name: Short
    args: Contract

    @model_validator(mode="after")
    def arguments_valid(self, info: ValidationInfo) -> Self:
        ctx = context(info)
        if self.name not in ctx.allowed_tools or self.name not in TOOL_ARGS:
            raise ValueError("tool is not enabled for this request")
        values = self.args.model_dump(exclude_none=True, by_alias=True)
        ids = values.get("event_ids", [])
        ids += [values[k] for k in ("event_id", "to_event_id") if k in values]
        if self.name == "get_event":
            ids.append(values["id"])
        if len(ids) != len(set(ids)) or not set(ids).issubset(ctx.event_ids):
            raise ValueError("event IDs must be known and unique")
        return self


ToolCall = Annotated[
    Union[tuple(create_model(name + "_call", __base__=ToolCallBase,
                             name=(Literal[name], ...), args=(args, ...))
                for name, args in TOOL_ARGS.items())],
    Field(discriminator="name"),
]


class AgentTurn(Contract):
    kind: Literal["answer", "tools", "insufficient_evidence"]
    answer: Annotated[str, Field(max_length=8000)]
    citations: Annotated[list[Id], Field(max_length=50)]
    tool_calls: Annotated[list[ToolCall], Field(max_length=8)]

    @model_validator(mode="after")
    def consistent(self, info: ValidationInfo) -> Self:
        ctx = context(info)
        if self.kind == "tools":
            if not self.tool_calls or self.answer or self.citations:
                raise ValueError("tool turn requires calls and no answer or citations")
        elif not self.answer.strip() or self.tool_calls:
            raise ValueError("answer requires text and no tool calls")
        known = {e.id for e in ctx.evidence}
        if len(self.citations) != len(set(self.citations)) or not set(self.citations) <= known:
            raise ValueError("citations must be unique supplied evidence IDs")
        if ctx.require_citations and self.kind == "answer" and not self.citations:
            raise ValueError("answer requires citations; otherwise report insufficient_evidence")
        return self


OUTPUTS: dict[str, type[Contract]] = {
    "extraction": Extraction, "rating": EventRating, "enrichment": Enrichment,
    "verification": Verification, "summary": Summary, "judge": JudgeScore, "agent": AgentTurn,
}


def validate_output(task: str, raw: str, ctx: Context) -> Contract:
    # A real JSON parser rejects wrappers, duplicate keys and non-standard constants.
    def pairs(items: list[tuple[str, object]]) -> dict[str, object]:
        result: dict[str, object] = {}
        for key, value in items:
            if key in result:
                raise ValueError("duplicate JSON property")
            result[key] = value
        return result
    def constant(_: str) -> None:
        raise ValueError("non-finite JSON number")
    json.loads(raw, object_pairs_hook=pairs, parse_constant=constant)
    return OUTPUTS[task].model_validate_json(raw, context={"request": ctx})
