"""What a chat request tells the agent CLI: the user's message with only what changed around it.

A resumed conversation already holds what it read: the prompt names unchanged sources,
context and target once, by id, so the agent does not reload them. Kavot's standing
policy is written once in the conversation folder (AGENTS.md / CLAUDE.md), not resent.
"""
from __future__ import annotations

import hashlib
import json
from datetime import datetime
from pathlib import Path

from app.core.agents import context as agent_context, conversations, digests
from app.core.kernel.config import settings
from app.mcp.context_view import compact_context
from app.mcp.instructions import INSTRUCTIONS

MODE_RULES = {
    "answer": "\nAnswer without any action or structured proposal. Be concise: no preamble, no restating the request.",
    "propose": "\nMode /edit: use the write tools to prepare changes; the user reviews each proposal.",
    "auto": "\nMode /auto: the user allowed direct changes. The write tools apply immediately; "
            "do exactly what was asked, nothing more, and summarize every applied change at the end.",
}
# Selected notes shown in the prompt as level-1 briefs (~100 tokens each); the rest by title.
PROMPT_BRIEFS = 12


def _digest(value) -> str:
    return hashlib.sha1(json.dumps(value, sort_keys=True, ensure_ascii=False, default=str).encode()).hexdigest()[:10]


def write_instructions(session: dict, cwd: str) -> None:
    """Write Kavot's standing policy where the CLI reads it once (AGENTS.md / CLAUDE.md / .opencode rules).

    Keeping it out of the user prompt avoids resending ~900 tokens in every message
    of a resumed conversation, and lets the provider cache the file read.
    """
    home = Path(cwd)
    if home != conversations.home(session) or home.resolve() == settings.storage_path.resolve():
        return  # A resumed conversation runs where it was started: never add files there.
    home.mkdir(parents=True, exist_ok=True)
    rules = agent_context.POLICY
    # Codex copies an MCP server's instructions into every tool description, so a
    # tool listing would repeat them dozens of times: its tool rules live here instead.
    if session["engine"] == "codex" and (session.get("tool_rules_in_agents") or not session.get("vendor_session_id")):
        session["tool_rules_in_agents"] = True
        rules += "\n" + INSTRUCTIONS
    (home / "AGENTS.md").write_text(rules + "\n", encoding="utf-8")
    (home / "CLAUDE.md").write_text("Read AGENTS.md.\n" + agent_context.POLICY + "\n", encoding="utf-8")


def _source_line(item: dict, brief: bool) -> str:
    """A selected source in the prompt: a note as its level-1 brief, so the agent opens it only if needed."""
    if brief and item.get("kind") == "note" and item.get("note_id"):
        from app.core.digest import levels
        try:
            return f"- {item['id']}: " + levels.line(levels.brief(item["note_id"]))
        except (ValueError, OSError):
            pass  # Not indexed yet: the title and path still name it.
    return f"- {item['id']}: {item['title']} — {item['path']}"


def _context_version(snapshot: dict) -> tuple[str, dict[str, str], dict[str, str]]:
    """Short fingerprints of what get_context returns (whole and per key) and of each selected source's text."""
    context = compact_context(snapshot)
    sources = {source["id"]: _digest([source.get("text"), source.get("pages")]) for source in snapshot.get("sources", [])}
    return _digest([context, sources, INSTRUCTIONS]), sources, {key: _digest(value) for key, value in context.items()}


def _freshness(resumed: bool, session: dict, version: str, keys: dict[str, str]) -> str:
    """What the prompt says about the view: nothing for a new conversation, else only what changed."""
    if not resumed:
        return ""
    if session.get("context_version") == version:
        return ("Context unchanged since your previous message: reuse the context, guides and sources already "
                "read in this conversation.\n")
    before = session.get("context_keys") or {}
    changed = sorted(key for key in {*keys, *before} if before.get(key) != keys.get(key)) if before else []
    return ("Context changed since your previous message" + (" (" + ", ".join(changed) + ")" if changed else "") +
            ". Everything else read in this conversation still holds; call get_context only if the request needs "
            "these changes (it then returns only what changed).\n")


def focus_lines(focus) -> list[str]:
    """What the user picked in the chat (project, notes, articles, folders, collection), with addresses to explore."""
    return [f"- {item.get('kind', 'item')}: {str(item.get('title') or '')[:120]}"
            + (f" ({item['count']} items)" if item.get("count") else "") + (f" — {item['ref']}" if item.get("ref") else "")
            for item in (focus or [])[:20] if isinstance(item, dict)]


def compose(session: dict, prompt: str, mode: str, context: dict, snapshot: dict, resources: list[dict],
            target: dict | None, resumed: bool, root: Path) -> str:
    """The full prompt of a request; records on ``session`` what it told, for the next message."""
    version, sources, context_keys = _context_version(snapshot)
    seen = session.get("source_versions") or {} if resumed else {}
    # An unchanged source was already briefed in an earlier message of this conversation.
    unchanged = {item["id"] for item in resources if item["id"] in sources and seen.get(item["id"]) == sources[item["id"]]}
    # Unchanged sources are named once, by id: their brief and what was read of them are already in the conversation.
    detail = [_source_line(item, brief=index < PROMPT_BRIEFS) for index, item in enumerate(resources) if item["id"] not in unchanged]
    if unchanged:
        detail.append("- unchanged since a previous message (reuse their brief and what you read): " +
                      ", ".join(item["id"] for item in resources if item["id"] in unchanged))
    # Briefed notes without a current summary get one in the background, for the next messages.
    digests.queue(*[f"kavot://notes/{item['note_id']}" for item in resources[:PROMPT_BRIEFS]
                    if item.get("kind") == "note" and item.get("note_id")])
    freshness = _freshness(resumed, session, version, context_keys)
    session.update(context_version=version, context_keys=context_keys, source_versions={**seen, **sources})
    focus = focus_lines(snapshot.get("focus"))
    explicit_target = bool(context.get("target_note_id") and str(context.get("target_note_id")) != str(context.get("note_id") or ""))
    target_label = "Note cible choisie" if explicit_target else "Default open note"
    target_instruction = (f"{target_label} : {target['title']} — {target['path']}. "
                          "If the request explicitly names another note, use that other note. "
                          "Otherwise, use this target note.\n" if target else "")
    # The context the user picked and the target note are repeated in full only when they change.
    focus_digest, target_digest = _digest(focus), _digest(target_instruction)
    if focus and resumed and session.get("focus_digest") == focus_digest:
        focus = ["- unchanged since your previous message"]
    if target and resumed and session.get("target_digest") == target_digest:
        target_instruction = f"{target_label} : unchanged ({target['title']}).\n"
    session.update(focus_digest=focus_digest, target_digest=target_digest)
    # Relative dates ("next Monday") in tasks and events need the user's local date.
    today = datetime.now().astimezone().strftime("%A %Y-%m-%d %H:%M (UTC%z)")
    # The MCP server already carries INSTRUCTIONS as its system instructions, and the policy
    # lives in the conversation folder: neither is repeated in every message.
    return ("Mode : " + mode + "\nToday : " + today + "\nWorkspace Kavot : " + str(root) + "\n" + freshness + target_instruction +
            ("Context chosen by the user for this conversation:\n" + "\n".join(focus) + "\n" if focus else "") +
            ("Selected sources, as level-1 briefs (deeper: get_note(id, level=2|3), or read_source):\n" + "\n".join(detail) + "\n" if detail else "") +
            MODE_RULES[mode] + "\nDemande :\n" + prompt)


def run_model(config: dict, session: dict, mode: str) -> dict:
    """The model and effort of one request: the conversation's, or for a question (/answer) the lighter ones
    when the conversation keeps the engine's default model."""
    chosen = {"model": session.get("model", config["model"]), "effort": session.get("effort", config["effort"])}
    if mode == "answer" and chosen["model"] in {"", config["model"]}:
        if config.get("answer_model"):
            return {"model": config["answer_model"], "effort": config.get("answer_effort", "")}
        if config.get("answer_effort") and chosen["effort"] in {"", config["effort"]}:
            chosen["effort"] = config["answer_effort"]
    return chosen


def thread_usage(session: dict) -> dict:
    """The running total the engine reported after the previous message, which the next total includes.

    Codex reports its thread's tokens, Claude Code its session's cost.
    """
    if session.get("engine") not in {"codex", "claude"}:
        return {}
    if session.get("thread_usage"):
        return session["thread_usage"]
    # Conversations metered before the fix stored that running total as each message's usage.
    last = (session.get("usage_history") or [{}])[-1]
    keys = ("input", "cache_read", "output", "reasoning") if session["engine"] == "codex" else ("cost_usd",)
    return {key: last.get(key) or 0 for key in keys}
