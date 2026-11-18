"""
Serving benchmark: the application's own request, at 1 to 32 concurrent streams, on
whichever runtime is selected, with the hardware and model recorded beside the numbers.

    python -m grapevine_llm.bench run --output bench/results/vllm.json
    python -m grapevine_llm.bench compare --baseline bench/baseline/vllm.json --result bench/results/vllm.json
    python -m grapevine_llm.bench check      # every committed result against its baseline
    python -m grapevine_llm.bench accept bench/results/vllm.json --reviewed
    python -m grapevine_llm.bench table      # the Markdown table in llm/README.md

What is measured is the runtime, through the same transport and the same payload the
gate sends (client.build_payload): the agent's JSON Schema as a decoding constraint,
temperature 0, thinking off. Timestamps are taken where the tokens arrive, so TTFT is
request sent to first generated token and TPOT is (last - first) / (tokens - 1). The
gate's own validation and the chat route are not in these numbers; `npm run bench:ttft
-w server` measures those, one turn at a time.

Every prompt is unique after the system message, which carries the schema and is the
same on every request. So the runtime's prefix cache may serve that shared head and
nothing else; the share it did serve is reported when the runtime says.

One 32 GB card holds one of these servers at a time, so runtimes are benchmarked one
after another, each alone on the GPU. A run under contention measures the contention.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import platform
import re
import shutil
import subprocess
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from typing import Annotated, Literal

import httpx
from pydantic import Field

from .client import TRANSPORTS, build_payload, contract_message
from .contracts import Context, Contract, Evidence, request_schema, validate_output
from .pins import TRITON_KSERVE_URL, active_manifest, verify_runtime
from .settings import Settings, local_endpoint
from .streaming import GenerationLog

ROOT = Path(__file__).resolve().parents[2]
BENCH = ROOT / "llm/bench"
RESULTS = BENCH / "results"
BASELINES = BENCH / "baseline"

Runtime = Literal["ollama", "vllm", "triton"]
Prompt = Literal["short", "long"]
STREAMS = (1, 4, 8, 16, 32)


class Hardware(Contract):
    gpu: str
    gpu_memory_mib: Annotated[int, Field(ge=0)]
    driver: str
    # The newest CUDA the driver supports, as nvidia-smi prints it.
    cuda: str | None
    cpu: str
    os: str


class ServedModel(Contract):
    runtime: Runtime
    # What the running server reported, not what the manifest hopes for.
    runtime_version: str
    name: str
    quantization: str
    # Where the weights came from: an Ollama digest, or repository@revision.
    source: str
    # Triton only: the image by tag and digest, and the engine inside it.
    container: str | None = None
    backend: str | None = None
    # The running server matched its reviewed manifest when the run started.
    pinned: bool


class Workload(Contract):
    task: Literal["agent"] = "agent"
    max_tokens: Annotated[int, Field(ge=16, le=4096)]
    num_ctx: Annotated[int, Field(ge=2048)]
    temperature: Literal[0] = 0
    seed: int
    # Requests per level before the 3-per-stream floor is applied.
    requests: Annotated[int, Field(ge=1)]
    warmup: Annotated[int, Field(ge=0)]


class Percentiles(Contract):
    n: Annotated[int, Field(ge=0)]
    p50: float | None
    p95: float | None
    p99: float | None


class Level(Contract):
    prompt: Prompt
    streams: Annotated[int, Field(ge=1, le=256)]
    requests: Annotated[int, Field(ge=1)]
    # Transport failures and timeouts. A truncated answer counts here too.
    errors: Annotated[int, Field(ge=0)]
    # Answers that arrived whole but did not satisfy the agent contract.
    invalid: Annotated[int, Field(ge=0)]
    ttft_ms: Percentiles
    tpot_ms: Percentiles
    e2e_ms: Percentiles
    # Decode rate of one stream: (tokens - 1) / (last token - first token).
    stream_tokens_per_s: Percentiles
    # Every output token of the level over its wall time: what the GPU delivered.
    total_tokens_per_s: float
    prompt_tokens: Percentiles
    output_tokens: Percentiles
    # Share of prompt tokens the runtime said it read from its prefix cache.
    cached_prompt_share: float | None
    wall_s: Annotated[float, Field(ge=0)]


class BenchReport(Contract):
    version: Literal["1.0.0"] = "1.0.0"
    created: str
    revision: str
    hardware: Hardware
    model: ServedModel
    workload: Workload
    levels: Annotated[list[Level], Field(min_length=1)]


# ---------------------------------------------------------------------------
# The workload
# ---------------------------------------------------------------------------

_VENUES = ["Waterfront Park", "Liberty Station", "The Rady Shell", "Balboa Park", "North Park Mini Park",
           "Little Italy Mercato", "Ocean Beach Pier", "Seaport Village"]
_KINDS = [("Shoreline Jazz", "free admission"), ("Night Market", "free admission"),
          ("Taco Festival", "$15 at the door"), ("Sunset Yoga", "free admission"),
          ("Indie Film Night", "$12 online"), ("Farmers Market", "free admission"),
          ("Comedy Showcase", "$20 advance"), ("Family Science Fair", "free admission")]
_DAYS = ["Friday", "Saturday", "Sunday"]
_DETAIL = (" Doors open thirty minutes before the listed start, kids are welcome until eight, and"
           " rideshare drop-off is on the side street. Food vendors line the block with shaded seating"
           " nearby, and street parking is a short walk away. Check the organizer's page on the day for"
           " weather changes and for the accessible entrance.")


def evidence(prompt: Prompt) -> list[Evidence]:
    """Three listings for the short prompt; enough detailed ones for about 4,000 tokens."""
    count = 3 if prompt == "short" else 35
    items = []
    for i in range(count):
        title, price = _KINDS[i % len(_KINDS)]
        text = (f"{title} at {_VENUES[(i * 3) % len(_VENUES)]}, {_DAYS[i % len(_DAYS)]} November"
                f" {6 + i % 3}, 2026, {5 + i % 4} PM to {8 + i % 3} PM. {price.capitalize()}.")
        items.append(Evidence(id=f"event-{i}", text=text + (_DETAIL if prompt == "long" else "")))
    return items


def question(prompt: Prompt, nonce: int) -> str:
    listing = json.dumps([e.model_dump() for e in evidence(prompt)])
    # The nonce comes first so nothing after the system message can be a cache hit.
    return (f"Request {nonce}. Which listed events on Saturday have free admission? Name each one with its"
            f" venue and start time in about 100 words, and cite it. Evidence: {listing}")


# ---------------------------------------------------------------------------
# Measurement
# ---------------------------------------------------------------------------


def percentile(values: list[float], p: float) -> float | None:
    """Nearest rank, as server/src/evals/stats.ts does: a value that was really observed."""
    if not values:
        return None
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, max(0, math.ceil(p / 100 * len(ordered)) - 1))]


def percentiles(values: list[float | None]) -> Percentiles:
    seen = [float(v) for v in values if v is not None]
    return Percentiles(n=len(seen), p50=percentile(seen, 50), p95=percentile(seen, 95), p99=percentile(seen, 99))


class Sample(Contract):
    error: str | None = None
    valid: bool = False
    ttft_ms: float | None = None
    tpot_ms: float | None = None
    e2e_ms: float | None = None
    prompt_tokens: int | None = None
    cached_prompt_tokens: int | None = None
    output_tokens: int | None = None


def one_request(settings: Settings, prompt: Prompt, nonce: int, max_tokens: int, timeout: float,
                transports=TRANSPORTS) -> Sample:
    schema = request_schema("agent", [])
    supplied = evidence(prompt)
    payload = build_payload(settings, schema, [contract_message("agent", schema),
                                               {"role": "user", "content": question(prompt, nonce)}],
                            num_predict=max_tokens)
    log = GenerationLog()
    send = transports[settings.runtime](settings.base_url, settings.max_bytes, lambda: log)
    try:
        raw = send(payload, timeout)
    except Exception as exc:  # A benchmark records every way a request can fail.
        return Sample(error=type(exc).__name__)
    done = time.perf_counter()
    timing = log.stats()
    try:
        validate_output("agent", raw, Context(event_ids=[e.id for e in supplied], evidence=supplied,
                                              require_citations=True))
        valid = True
    except ValueError:
        valid = False
    return Sample(valid=valid, ttft_ms=timing["first_token_ms"], tpot_ms=timing["tpot_ms"],
                  e2e_ms=(done - log.sent) * 1000, prompt_tokens=timing["prompt_tokens"],
                  cached_prompt_tokens=timing["cached_prompt_tokens"], output_tokens=timing["output_tokens"])


def summarize(prompt: Prompt, streams: int, samples: list[Sample], wall_s: float) -> Level:
    ok = [s for s in samples if s.error is None]
    counted = [s for s in ok if s.prompt_tokens and s.cached_prompt_tokens is not None]
    prompt_total = sum(s.prompt_tokens or 0 for s in counted)
    return Level(
        prompt=prompt, streams=streams, requests=len(samples),
        errors=len(samples) - len(ok), invalid=sum(not s.valid for s in ok),
        ttft_ms=percentiles([s.ttft_ms for s in ok]),
        tpot_ms=percentiles([s.tpot_ms for s in ok]),
        e2e_ms=percentiles([s.e2e_ms for s in ok]),
        stream_tokens_per_s=percentiles([1000 / s.tpot_ms if s.tpot_ms else None for s in ok]),
        total_tokens_per_s=sum(s.output_tokens or 0 for s in ok) / wall_s if wall_s > 0 else 0.0,
        prompt_tokens=percentiles([s.prompt_tokens for s in ok]),
        output_tokens=percentiles([s.output_tokens for s in ok]),
        cached_prompt_share=(sum(s.cached_prompt_tokens or 0 for s in counted) / prompt_total
                             if prompt_total else None),
        wall_s=wall_s)


def run_level(settings: Settings, prompt: Prompt, streams: int, requests: int, max_tokens: int,
              timeout: float, first_nonce: int, transports=TRANSPORTS) -> Level:
    """A closed loop: `streams` requests in flight until `requests` have been sent."""
    def call(i: int) -> Sample:
        return one_request(settings, prompt, first_nonce + i, max_tokens, timeout, transports)

    started = time.perf_counter()
    with ThreadPoolExecutor(max_workers=streams) as pool:
        samples = list(pool.map(call, range(requests)))
    return summarize(prompt, streams, samples, time.perf_counter() - started)


# ---------------------------------------------------------------------------
# What ran, and on what
# ---------------------------------------------------------------------------


def _text(command: list[str]) -> str:
    try:
        return subprocess.run(command, capture_output=True, text=True, timeout=15, check=True).stdout
    except (OSError, subprocess.SubprocessError):
        return ""


def _cpu() -> str:
    if platform.system() == "Windows":
        try:
            import winreg
            with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r"HARDWARE\DESCRIPTION\System\CentralProcessor\0") as key:
                return str(winreg.QueryValueEx(key, "ProcessorNameString")[0]).strip()
        except OSError:
            pass
    try:
        for line in Path("/proc/cpuinfo").read_text(encoding="utf-8").splitlines():
            if line.startswith("model name"):
                return line.split(":", 1)[1].strip()
    except OSError:
        pass
    return platform.processor() or "unknown"


def hardware() -> Hardware:
    """Refuses to guess: a result without its GPU and driver is not a result."""
    if not shutil.which("nvidia-smi"):
        raise RuntimeError("nvidia-smi is required to record the GPU and driver")
    row = _text(["nvidia-smi", "--query-gpu=name,driver_version,memory.total", "--format=csv,noheader,nounits"])
    fields = [f.strip() for f in row.splitlines()[0].split(",")] if row.strip() else []
    if len(fields) != 3:
        raise RuntimeError("nvidia-smi did not report a GPU")
    # Older drivers print "CUDA Version", newer ones "CUDA UMD Version".
    cuda = re.search(r"CUDA(?: UMD)? Version:\s*([\d.]+)", _text(["nvidia-smi"]))
    return Hardware(gpu=fields[0], driver=fields[1], gpu_memory_mib=int(float(fields[2])),
                    cuda=cuda.group(1) if cuda else None, cpu=_cpu(), os=platform.platform())


def runtime_version(settings: Settings) -> str:
    base = local_endpoint(settings.base_url)
    url = {"ollama": f"{base}/api/version", "vllm": f"{base}/version"}.get(settings.runtime)
    if url is None:
        kserve = local_endpoint(os.environ.get("GRAPEVINE_TRITON_KSERVE_URL") or TRITON_KSERVE_URL)
        url = f"{kserve}/v2"
    with httpx.Client(trust_env=False, follow_redirects=False, timeout=5) as client:
        response = client.get(url)
        response.raise_for_status()
        return str(json.loads(response.content)["version"])


def served_model(settings: Settings) -> ServedModel:
    pins = active_manifest(settings.runtime)
    pin = pins.generation
    try:
        verify_runtime(settings.runtime, settings.base_url, settings.num_ctx)
        pinned = settings.model == pin.name
    except (ValueError, httpx.HTTPError, OSError):
        pinned = False
    return ServedModel(
        runtime=settings.runtime, runtime_version=runtime_version(settings), name=settings.model,
        quantization=pin.quantization,
        source=getattr(pin, "digest", None) or f"{pin.repository}@{pin.revision}",
        container=getattr(pins, "container", None),
        backend=(f"{pins.backend} {pins.backend_version}" if hasattr(pins, "backend") else None),
        pinned=pinned)


# What a measurement depends on: the harness and gate, their locked dependencies, the
# model records, and what Triton is started from. Documentation can change under a run.
MEASURED_PATHS = ["llm/grapevine_llm", "llm/uv.lock", "llm/evals/models.json", "llm/evals/models.vllm.json",
                  "llm/evals/models.triton.json", "docker/triton"]


def revision() -> str:
    """The commit that was measured, marked when the measured files differed from it."""
    head = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
    changed = subprocess.check_output(["git", "status", "--porcelain", "--", *MEASURED_PATHS], cwd=ROOT, text=True)
    return head + ("-dirty" if changed.strip() else "")


def run(settings: Settings, *, streams: tuple[int, ...] = STREAMS, prompts: tuple[Prompt, ...] = ("short", "long"),
        requests: int = 48, max_tokens: int = 256, warmup: int = 2, timeout: float = 600,
        allow_unpinned: bool = False, progress=print) -> BenchReport:
    model = served_model(settings)
    if not model.pinned and not allow_unpinned:
        raise ValueError("the running runtime or model differs from its reviewed manifest; "
                         "fix that or pass --allow-unpinned to record an unpinned run")
    machine = hardware()
    # Taken before the run, so an edit made while it measures is not attributed to it.
    measured = revision()
    for i in range(warmup):
        one_request(settings, "short", -1 - i, max_tokens, timeout)
    levels: list[Level] = []
    nonce = 0
    for prompt in prompts:
        for n in streams:
            # At least three per stream, so a level is more than one batch.
            count = max(requests, 3 * n)
            level = run_level(settings, prompt, n, count, max_tokens, timeout, nonce)
            nonce += count
            levels.append(level)
            progress(f"{settings.runtime} {prompt} x{n}: ttft p50 {level.ttft_ms.p50 or 0:.0f} ms, "
                     f"tpot p50 {level.tpot_ms.p50 or 0:.1f} ms, {level.total_tokens_per_s:.0f} tok/s, "
                     f"{level.errors} errors, {level.invalid} invalid")
    return BenchReport(created=datetime.now(timezone.utc).isoformat(timespec="seconds"), revision=measured,
                       hardware=machine, model=model,
                       workload=Workload(max_tokens=max_tokens, num_ctx=settings.num_ctx, seed=settings.seed,
                                         requests=requests, warmup=warmup),
                       levels=levels)


# ---------------------------------------------------------------------------
# Regression against a stored baseline
# ---------------------------------------------------------------------------


class Incomparable(ValueError):
    """The two runs are not of the same thing, so no verdict would mean anything."""


# How far a number may move before it counts, set above what two back-to-back identical
# runs of the vLLM matrix showed on 2026-11-18 (llm/README.md has the figures). Token
# time repeated within 5%, median end-to-end time within 6%, its p95 within 15%, and
# throughput within 3%.
TOLERANCE = {"p50": 0.15, "p95": 0.30}
# First-token time with more than one stream did not repeat: it depends on where in the
# engine's batch a request lands, and its median moved 26% between the two runs. It
# gets a wider band, which still catches a request that starts queueing.
TTFT_CONCURRENT_TOLERANCE = {"p50": 0.40, "p95": 0.50}
# Below these absolute differences a change is timer and scheduler noise.
FLOOR_MS = {"ttft_ms": 25.0, "tpot_ms": 1.5, "e2e_ms": 100.0}
# p99 is only gated with enough samples to mean something.
P99_MIN_SAMPLES = 100
THROUGHPUT_TOLERANCE = 0.15


def fingerprint(report: BenchReport) -> dict[str, object]:
    """What must be identical for two runs to be compared."""
    m, w = report.model, report.workload
    return {"gpu": report.hardware.gpu, "gpu_memory_mib": report.hardware.gpu_memory_mib,
            "runtime": m.runtime, "runtime_version": m.runtime_version, "model": m.name,
            "quantization": m.quantization, "source": m.source, "container": m.container,
            "backend": m.backend, "max_tokens": w.max_tokens, "num_ctx": w.num_ctx, "seed": w.seed}


def compare(baseline: BenchReport, result: BenchReport) -> tuple[list[str], list[str]]:
    """(regressions, notes). Raises Incomparable when the runs are of different things."""
    before, after = fingerprint(baseline), fingerprint(result)
    different = sorted(k for k in before if before[k] != after[k])
    if different:
        raise Incomparable("not comparable: " + ", ".join(f"{k} {before[k]!r} -> {after[k]!r}" for k in different))
    if not result.model.pinned:
        raise Incomparable("the result was recorded on an unpinned runtime")
    notes = []
    if baseline.hardware.driver != result.hardware.driver:
        notes.append(f"driver {baseline.hardware.driver} -> {result.hardware.driver}")
    regressions: list[str] = []
    measured = {(lv.prompt, lv.streams): lv for lv in result.levels}
    for old in baseline.levels:
        label = f"{old.prompt} x{old.streams}"
        new = measured.get((old.prompt, old.streams))
        if new is None:
            regressions.append(f"{label}: level missing from the result")
            continue
        if new.errors > old.errors or new.invalid > old.invalid:
            regressions.append(f"{label}: {new.errors} errors and {new.invalid} invalid answers, "
                               f"against {old.errors} and {old.invalid}")
        for metric, floor in FLOOR_MS.items():
            was, now = getattr(old, metric), getattr(new, metric)
            quantiles = dict(TTFT_CONCURRENT_TOLERANCE if metric == "ttft_ms" and old.streams > 1 else TOLERANCE)
            if min(was.n, now.n) >= P99_MIN_SAMPLES:
                quantiles["p99"] = quantiles["p95"]
            for q, tolerance in quantiles.items():
                a, b = getattr(was, q), getattr(now, q)
                if a is None or b is None:
                    if a is not None:
                        regressions.append(f"{label}: {metric} {q} was {a:.1f} and is now missing")
                    continue
                if b > a * (1 + tolerance) and b - a > floor:
                    regressions.append(f"{label}: {metric} {q} {a:.1f} -> {b:.1f} ms "
                                       f"(+{(b / a - 1) * 100:.0f}%, limit {tolerance * 100:.0f}%)")
        if new.total_tokens_per_s < old.total_tokens_per_s * (1 - THROUGHPUT_TOLERANCE):
            regressions.append(f"{label}: throughput {old.total_tokens_per_s:.0f} -> {new.total_tokens_per_s:.0f} "
                               f"tok/s (limit -{THROUGHPUT_TOLERANCE * 100:.0f}%)")
    return regressions, notes


def load(path: Path) -> BenchReport:
    return BenchReport.model_validate_json(path.read_bytes())


def git_blob(ref: str, path: str) -> bytes | None:
    """A file as it is on another ref, or None when that ref does not have it."""
    exists = subprocess.run(["git", "cat-file", "-e", f"{ref}:{path}"], cwd=ROOT, capture_output=True)
    if exists.returncode:
        # A missing path is the first rollout; an unknown ref is a mistake.
        subprocess.run(["git", "rev-parse", "--verify", ref], cwd=ROOT, check=True, capture_output=True)
        return None
    return subprocess.check_output(["git", "show", f"{ref}:{path}"], cwd=ROOT)


def check(results: Path = RESULTS, baselines: Path = BASELINES, base_ref: str | None = None) -> list[str]:
    """
    Every committed result against its baseline. A result with no baseline fails.

    With base_ref, each result is also held to the baseline on that ref, so a pull
    request cannot slow a runtime down and replace the baseline in the same change.
    A base baseline of a different runtime version, model or GPU is not compared:
    re-pinning is a reviewed change to what is being measured.
    """
    failures: list[str] = []
    files = sorted(results.glob("*.json"))
    if not files:
        failures.append(f"no benchmark results under {results.as_posix()}")
    for path in files:
        baseline = baselines / path.name
        if not baseline.exists():
            failures.append(f"{path.name}: no stored baseline")
            continue
        try:
            result = load(path)
            regressions, _ = compare(load(baseline), result)
        except ValueError as exc:
            failures.append(f"{path.name}: {exc}")
            continue
        failures += [f"{path.name}: {r}" for r in regressions]
        previous = git_blob(base_ref, f"llm/bench/baseline/{path.name}") if base_ref else None
        if previous:
            try:
                regressions, _ = compare(BenchReport.model_validate_json(previous), result)
            except Incomparable:
                continue
            failures += [f"{path.name}: against {base_ref}: {r}" for r in regressions]
    return failures


# ---------------------------------------------------------------------------
# Reporting
# ---------------------------------------------------------------------------


def _three(p: Percentiles, digits: int = 0) -> str:
    return "/".join("n/a" if v is None else f"{v:.{digits}f}" for v in (p.p50, p.p95, p.p99))


def table(reports: list[BenchReport]) -> str:
    rows = ["| Runtime | Prompt | Streams | n | TTFT p50/p95/p99 ms | TPOT p50/p95/p99 ms | "
            "End-to-end p50/p95/p99 ms | tok/s per stream p50 | tok/s total | Errors | Invalid |",
            "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |"]
    names = {"ollama": "Ollama", "vllm": "vLLM", "triton": "Triton"}
    for report in reports:
        for lv in report.levels:
            rows.append(f"| {names[report.model.runtime]} | {lv.prompt} | {lv.streams} | {lv.requests} | "
                        f"{_three(lv.ttft_ms)} | {_three(lv.tpot_ms, 1)} | {_three(lv.e2e_ms)} | "
                        f"{lv.stream_tokens_per_s.p50 or 0:.0f} | {lv.total_tokens_per_s:.0f} | "
                        f"{lv.errors} | {lv.invalid} |")
    return "\n".join(rows)


def provenance_table(reports: list[BenchReport]) -> str:
    rows = ["| Runtime | Version | Model | Quantization | Source | GPU | Driver | CUDA | Commit |",
            "| --- | --- | --- | --- | --- | --- | --- | --- | --- |"]
    names = {"ollama": "Ollama", "vllm": "vLLM", "triton": "Triton"}
    for r in reports:
        m, h = r.model, r.hardware
        version = m.runtime_version + (f" ({m.backend})" if m.backend else "")
        commit = r.revision[:7] + (" (uncommitted changes)" if r.revision.endswith("-dirty") else "")
        rows.append(f"| {names[m.runtime]} | {version} | `{m.name}` | {m.quantization} | `{m.source[:19]}` | "
                    f"{h.gpu} ({h.gpu_memory_mib} MiB) | {h.driver} | {h.cuda or 'n/a'} | `{commit}` |")
    return "\n".join(rows)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest="command", required=True)
    go = commands.add_parser("run")
    go.add_argument("--output", type=Path, required=True)
    go.add_argument("--streams", default=",".join(map(str, STREAMS)))
    go.add_argument("--prompts", default="short,long")
    go.add_argument("--requests", type=int, default=48)
    go.add_argument("--max-tokens", type=int, default=256)
    go.add_argument("--warmup", type=int, default=2)
    go.add_argument("--timeout", type=float, default=600)
    go.add_argument("--allow-unpinned", action="store_true")
    versus = commands.add_parser("compare")
    versus.add_argument("--baseline", type=Path, required=True)
    versus.add_argument("--result", type=Path, required=True)
    gate = commands.add_parser("check")
    gate.add_argument("--base-ref", help="also hold each result to the baseline on this ref")
    accept = commands.add_parser("accept")
    accept.add_argument("result", type=Path)
    accept.add_argument("--reviewed", action="store_true", help="confirm the run was alone on the GPU and its numbers were read")
    commands.add_parser("table")
    args = parser.parse_args()

    if args.command == "run":
        report = run(Settings(), streams=tuple(int(s) for s in args.streams.split(",")),
                     prompts=tuple(args.prompts.split(",")), requests=args.requests,
                     max_tokens=args.max_tokens, warmup=args.warmup, timeout=args.timeout,
                     allow_unpinned=args.allow_unpinned)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(report.model_dump_json(indent=2) + "\n", encoding="utf-8", newline="\n")
        print(f"wrote {args.output}")
    elif args.command == "compare":
        try:
            regressions, notes = compare(load(args.baseline), load(args.result))
        except Incomparable as exc:
            raise SystemExit(f"{exc}") from exc
        for note in notes:
            print(f"note: {note}")
        for regression in regressions:
            print(f"regression: {regression}")
        print("no regression past the baseline" if not regressions else f"{len(regressions)} regression(s)")
        raise SystemExit(1 if regressions else 0)
    elif args.command == "check":
        failures = check(base_ref=args.base_ref)
        for failure in failures:
            print(f"regression: {failure}")
        print("bench gate passed" if not failures else f"{len(failures)} failure(s)")
        raise SystemExit(1 if failures else 0)
    elif args.command == "accept":
        if not args.reviewed:
            parser.error("read the numbers, then pass --reviewed")
        report = load(args.result)
        if not report.model.pinned:
            raise SystemExit("an unpinned run cannot become a baseline")
        BASELINES.mkdir(parents=True, exist_ok=True)
        (BASELINES / args.result.name).write_text(report.model_dump_json(indent=2) + "\n", encoding="utf-8",
                                                  newline="\n")
        print(f"baseline replaced: {args.result.name}")
    else:
        reports = [load(p) for p in sorted(RESULTS.glob("*.json"))]
        print(provenance_table(reports))
        print()
        print(table(reports))


if __name__ == "__main__":
    main()
