"""Token usage of an agent CLI, as each engine reports it in its JSON stream."""
from __future__ import annotations

from typing import Any

USAGE_KEYS = ("input", "output", "cache_read", "cache_write", "reasoning", "cost_usd", "turns", "duration_ms")


def add(first: dict[str, Any], second: dict[str, Any]) -> dict[str, Any]:
    return {key: (first.get(key) or 0) + (second.get(key) or 0) for key in USAGE_KEYS}


class Meter:
    """Usage of one agent invocation."""

    def __init__(self, engine: str, baseline: dict[str, Any] | None = None):
        self.engine, self.messages, self.total, self.final = engine, {}, {}, None
        # Codex reports the thread's running total, and Claude Code its running cost, resumed
        # messages included: this message's usage is that total minus the one recorded after the previous message.
        self.baseline, self.cumulative = baseline or {}, {}

    def feed(self, event: Any) -> bool:
        if not isinstance(event, dict):
            return False
        kind = event.get("type")
        if self.engine == "claude":
            if kind == "assistant":
                message = event.get("message") or {}
                usage = message.get("usage") or {}
                if not usage:
                    return False
                self.messages[message.get("id") or len(self.messages)] = {
                    "input": usage.get("input_tokens"), "output": usage.get("output_tokens"),
                    "cache_read": usage.get("cache_read_input_tokens"), "cache_write": usage.get("cache_creation_input_tokens")}
                return True
            if kind == "result":
                usage = event.get("usage") or {}
                # A resumed session reports its running cost, earlier messages included:
                # this message's cost is that total minus the one recorded after the previous message.
                cost = event.get("total_cost_usd")
                if cost is not None:
                    self.cumulative = {"cost_usd": cost}
                    base = self.baseline.get("cost_usd") or 0
                    cost = cost - base if cost >= base else cost
                self.final = {"input": usage.get("input_tokens"), "output": usage.get("output_tokens"),
                              "cache_read": usage.get("cache_read_input_tokens"), "cache_write": usage.get("cache_creation_input_tokens"),
                              "cost_usd": cost, "turns": event.get("num_turns"), "duration_ms": event.get("duration_ms")}
                return True
        elif self.engine == "codex" and kind == "turn.completed":
            usage = event.get("usage") or {}
            # Codex counts cached tokens inside its input tokens.
            cached = usage.get("cached_input_tokens") or 0
            self.cumulative = {"input": max(0, (usage.get("input_tokens") or 0) - cached), "cache_read": cached,
                               "output": usage.get("output_tokens"), "reasoning": usage.get("reasoning_output_tokens")}
            # A total below the baseline means a new thread (fresh start): nothing to subtract.
            seen = (self.baseline.get("input") or 0) + (self.baseline.get("cache_read") or 0)
            base = self.baseline if (usage.get("input_tokens") or 0) >= seen else {}
            self.total = {**{key: max(0, (self.cumulative.get(key) or 0) - (base.get(key) or 0)) for key in self.cumulative}, "turns": 1}
            return True
        elif self.engine == "opencode" and kind == "step_finish":
            part = event.get("part") or {}
            tokens = part.get("tokens") or {}
            cache = tokens.get("cache") or {}
            self.total = add(self.total, {"input": tokens.get("input"), "output": tokens.get("output"), "reasoning": tokens.get("reasoning"),
                                          "cache_read": cache.get("read"), "cache_write": cache.get("write"), "cost_usd": part.get("cost"), "turns": 1})
            return True
        return False

    def value(self) -> dict[str, Any]:
        if self.final:
            return add({}, self.final)
        if self.messages:
            total: dict[str, Any] = {}
            for usage in self.messages.values():
                total = add(total, usage)
            return {**total, "turns": len(self.messages)}
        return add({}, self.total)
