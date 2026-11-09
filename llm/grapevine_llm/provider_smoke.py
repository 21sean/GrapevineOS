"""Opt-in real provider check: uv run python -m grapevine_llm.provider_smoke codex."""
import argparse
import os
import json
from pathlib import Path

from .client import Message, Request, generate
from .settings import Settings
from .contracts import TOOL_ARGS


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("provider", choices=["codex", "claude"])
    parser.add_argument("--all-tasks", action="store_true", help="Exercise one public golden fixture per task")
    args = parser.parse_args()
    model = os.environ.get(f"GRAPEVINE_{args.provider.upper()}_MODEL") or (
        "gpt-6-astra" if args.provider == "codex" else "best")
    requests = [Request(id="smoke", task="summary", model=model,
        messages=[Message(role="user", content='Return {"summary":"Connected"}.')])]
    if args.all_tasks:
        seen = set()
        for line in (Path(__file__).resolve().parents[1] / "evals/golden.jsonl").read_text(encoding="utf-8").splitlines():
            case = json.loads(line)["request"]
            key = (case["task"], bool(case.get("context", {}).get("allowed_tools")))
            if key in seen:
                continue
            seen.add(key)
            if key == ("agent", True):
                case["context"]["allowed_tools"] = list(TOOL_ARGS)
            requests.append(Request(id=case["id"], task=case["task"], model=model,
                                    messages=case["messages"], context=case.get("context", {})))
    ok = True
    for request in requests:
        result = generate(request, Settings(provider=args.provider, max_attempts=1))
        print(json.dumps({"task": request.task, "ok": result.ok, "stats": result.stats.model_dump(),
                          **({"code": result.code, "message": result.message} if not result.ok else {})}), flush=True)
        ok &= result.ok
    raise SystemExit(0 if ok else 1)


if __name__ == "__main__":
    main()
