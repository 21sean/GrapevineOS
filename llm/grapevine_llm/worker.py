"""Bounded NDJSON worker. stdout is exclusively the validated wire protocol."""
import sys
from .client import Failure, Request, Stats, generate
from .settings import Settings

def main() -> None:
    settings = Settings()
    while True:
        line = sys.stdin.buffer.readline(settings.max_bytes + 1)
        if not line:
            return
        if len(line) > settings.max_bytes or not line.endswith(b"\n"):
            raise SystemExit("oversized or unterminated request")
        try:
            request = Request.model_validate_json(line)
        except ValueError:
            result = Failure(id="invalid", code="invalid_request", message="Invalid gate request",
                stats=Stats(attempts=0, validation_failures=0, first_pass=False,
                            validation_ms=0, total_ms=0, repair_ms=0))
        else:
            result = generate(request, settings)
        print(result.model_dump_json(by_alias=True), flush=True)

if __name__ == "__main__":
    main()
