"""What a conversation has already read, so a later identical read does not resend it.

Every tool result stays in the conversation and is reread on each model call: reading the
same note, page or context again in a later message only makes the conversation longer.
For a chat conversation, an identical read-only call whose result has not changed answers
"unchanged" instead of the full result; get_context answers only the keys that changed.

The memo is a guess about what is still in the agent's context. It is forgotten when the
conversation starts again, is compacted, or a request ends without completing; and an
agent that calls again in the same request after an "unchanged" answer gets the full
result (the earlier one was no longer in its context).
"""
from __future__ import annotations

import hashlib
import json
import threading
from typing import Any

# Smaller results cost about as much as the "unchanged" answer: they are always sent.
MIN_CHARS = 400
# Keys that change between calls without changing the content: get_context's clock, and the
# one-time request to save a summary of a note read in full.
VOLATILE = {"today", "digest"}

_lock = threading.Lock()
_memos: dict[str, dict[str, dict]] = {}


def _digest(value: Any) -> str:
    return hashlib.sha1(json.dumps(value, sort_keys=True, ensure_ascii=False, default=str).encode()).hexdigest()[:16]


def forget(conversation_id: str | None) -> None:
    """The agent's context no longer holds what it read (new or compacted conversation, interrupted request)."""
    if conversation_id:
        with _lock:
            _memos.pop(conversation_id, None)


def _stable(result: Any) -> Any:
    return {k: v for k, v in result.items() if k not in VOLATILE} if isinstance(result, dict) else result


def _context_changes(previous: dict, result: dict) -> dict | None:
    """get_context against the one this conversation already received: only the keys that changed."""
    before, after = previous.get("context") or {}, result.get("context") or {}
    if not isinstance(before, dict) or not isinstance(after, dict):
        return None
    changed = {key: value for key, value in after.items() if _digest(before.get(key)) != _digest(value)}
    removed = [key for key in before if key not in after]
    answer = {key: value for key, value in result.items() if key != "context"}
    answer.update(changed=changed, **({"removed": removed} if removed else {}),
                  note="Only what changed since your previous get_context in this conversation; the other keys "
                       "are as you received them. If that result is no longer in your context, call get_context again.")
    return answer


def recall(conversation_id: str | None, run_id: str, name: str, key: str, result: Any, text: str) -> str:
    """The text to send for this read: the full result, a diff (get_context), or "unchanged"."""
    if not conversation_id or len(text) < MIN_CHARS:
        return text
    digest = _digest(_stable(result))
    with _lock:
        memo = _memos.setdefault(conversation_id, {})
        entry = memo.get(key)
        # Asked again in the request that was told "unchanged": the agent no longer has it.
        resend = entry is not None and entry.get("short_in") == run_id
        memo[key] = {"digest": digest, "result": result if name == "get_context" else None,
                     "short_in": None if resend or entry is None else run_id}
    if entry is None or resend:
        return text
    if entry["digest"] == digest:
        return json.dumps({"unchanged": True, "note": f"Same result as your identical {name} call earlier in this "
                           "conversation: reuse it. If it is no longer in your context, call again for the full result."},
                          separators=(",", ":"))
    if name == "get_context" and isinstance(entry.get("result"), dict) and isinstance(result, dict):
        changes = _context_changes(entry["result"], result)
        if changes is not None:
            short = json.dumps(changes, separators=(",", ":"), ensure_ascii=False, default=str)
            if len(short) < len(text):
                return short
    with _lock:
        memo[key]["short_in"] = None
    return text
