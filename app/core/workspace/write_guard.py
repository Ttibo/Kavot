"""Protects what an agent just wrote into a note from an editor still holding the previous text.

Editors send the version they started from (`expected_hash`); a stale one is refused by `update_note`.
A client write without any version cannot be checked: right after an agent changed the note, it is refused
instead of silently restoring the older text. The editor then reloads the note."""
import threading
import time

AGENT_WRITE_GRACE_SECONDS = 30
_lock = threading.Lock()
_agent_writes: dict[int, float] = {}


def mark_agent_write(note_id: int) -> None:
    with _lock:
        _agent_writes[int(note_id)] = time.monotonic()


def blind_write_blocked(note_id: int) -> bool:
    """A client write without a version arrives just after an agent wrote this note."""
    with _lock:
        written = _agent_writes.get(int(note_id))
        if written is None:
            return False
        if time.monotonic() - written > AGENT_WRITE_GRACE_SECONDS:
            _agent_writes.pop(int(note_id), None)
            return False
        return True
