"""Watch one generation as it arrives: when tokens came, and the answer text inside the JSON."""
from __future__ import annotations

import time
from collections.abc import Callable

_SIMPLE_ESCAPES = {'"': '"', "\\": "\\", "/": "/", "b": "\b", "f": "\f", "n": "\n", "r": "\r", "t": "\t"}


class AnswerStream:
    """
    Pull the decoded value of the top-level "answer" key out of JSON text fed in
    arbitrary pieces, without waiting for the document to be whole.

    The agent's reply is schema-constrained JSON, so a person can only be shown the
    answer field and never the envelope around it. This does not validate anything:
    the complete document still goes through the contract gate, and anything shown
    from here gets retracted if it fails.
    """

    def __init__(self) -> None:
        self._depth = 0
        self._in_string = False
        self._escape = False
        self._unicode: str | None = None
        self._high_surrogate: int | None = None
        self._key: list[str] | None = None
        self._last_key: str | None = None
        self._in_answer = False
        self._expect_value = False

    def feed(self, text: str) -> str:
        out: list[str] = []
        for ch in text:
            self._step(ch, out)
        return "".join(out)

    def _step(self, ch: str, out: list[str]) -> None:
        if self._in_string:
            self._string_char(ch, out)
        elif ch == '"':
            self._in_string = True
            if self._depth == 1 and self._expect_value and self._last_key == "answer":
                self._in_answer = True
            elif self._depth == 1 and not self._expect_value:
                self._key = []
        elif ch == ":" and self._depth == 1:
            self._expect_value = True
        elif ch == "," and self._depth == 1:
            self._expect_value = False
        elif ch in "{[":
            self._depth += 1
        elif ch in "}]":
            self._depth -= 1

    def _string_char(self, ch: str, out: list[str]) -> None:
        if self._unicode is not None:
            self._unicode += ch
            if len(self._unicode) == 4:
                self._emit_code_unit(int(self._unicode, 16), out)
                self._unicode = None
        elif self._escape:
            self._escape = False
            if ch == "u":
                self._unicode = ""
            else:
                self._emit(_SIMPLE_ESCAPES.get(ch, ch), out)
        elif ch == "\\":
            self._escape = True
        elif ch == '"':
            self._in_string = False
            if self._key is not None:
                self._last_key = "".join(self._key)
                self._key = None
            self._in_answer = False
        else:
            self._emit(ch, out)

    def _emit_code_unit(self, unit: int, out: list[str]) -> None:
        if 0xD800 <= unit <= 0xDBFF:
            self._high_surrogate = unit
            return
        if 0xDC00 <= unit <= 0xDFFF and self._high_surrogate is not None:
            unit = 0x10000 + ((self._high_surrogate - 0xD800) << 10) + (unit - 0xDC00)
            self._high_surrogate = None
        self._emit(chr(unit), out)

    def _emit(self, text: str, out: list[str]) -> None:
        if self._key is not None:
            self._key.append(text)
        elif self._in_answer:
            out.append(text)


class GenerationLog:
    """Timestamps for one call to the runtime, taken where the tokens arrive."""

    def __init__(self, on_text: Callable[[str], None] | None = None) -> None:
        self._on_text = on_text
        self.sent: float = time.perf_counter()
        self.first_token: float | None = None
        self.first_reasoning: float | None = None
        self.last_token: float | None = None
        self.chunks = 0
        self.final: dict = {}

    def mark_sent(self) -> None:
        self.sent = time.perf_counter()

    def reasoning(self, text: str) -> None:
        if text and self.first_reasoning is None:
            self.first_reasoning = time.perf_counter()

    def token(self, text: str) -> None:
        if not text:
            return
        now = time.perf_counter()
        if self.first_token is None:
            self.first_token = now
        self.last_token = now
        self.chunks += 1
        if self._on_text:
            self._on_text(text)

    def _ms(self, stamp: float | None) -> float | None:
        return None if stamp is None else (stamp - self.sent) * 1000

    def _ns(self, key: str) -> float | None:
        value = self.final.get(key)
        return value / 1_000_000 if isinstance(value, (int, float)) else None

    def stats(self) -> dict:
        output_tokens = self.final.get("eval_count")
        count = output_tokens if isinstance(output_tokens, int) else self.chunks
        tpot = None
        if self.first_token is not None and self.last_token is not None and count > 1:
            tpot = (self.last_token - self.first_token) * 1000 / (count - 1)
        prompt_tokens = self.final.get("prompt_eval_count")
        return {
            "first_token_ms": self._ms(self.first_token),
            "first_reasoning_ms": self._ms(self.first_reasoning),
            "tpot_ms": tpot,
            "prompt_tokens": prompt_tokens if isinstance(prompt_tokens, int) else None,
            "output_tokens": count if count else None,
            "load_ms": self._ns("load_duration"),
            "prompt_eval_ms": self._ns("prompt_eval_duration"),
            "eval_ms": self._ns("eval_duration"),
        }
