"""Everything an agent needs to write notes the editor keeps: formats, embeds and scripts.

The guide mirrors the rich editor (frontend/src/features/documents) and the
sanitizer in html_documents: markup outside it is dropped on save.
"""
from __future__ import annotations

import html

from app.core.workspace import html_documents

SCRIPT_HEIGHTS = ("auto", "160", "240", "320", "480", "640")

GUIDE = {
    "principles": [
        "Notes are HTML fragments (the body only). Every block gets a stable id; keep existing ids.",
        "No <script>, <style>, <iframe>, <form> or event attributes in the body: they are removed. "
        "Interactive code goes in a script block (note_script_set), which runs in a sandbox.",
        "Prefer semantic structure (headings, lists, tables) over inline styles.",
    ],
    "text": {
        "blocks": "<h1>…<h6>, <p>, <blockquote>, <pre><code class=\"language-python\">…</code></pre>, <hr>",
        "inline": "<strong>, <em>, <u>, <s>, <code>, <mark>, <sub>, <sup>, <br>, <a href=\"https://…\">",
        "lists": "<ul>/<ol start=\"3\"> with <li>; nested lists inside <li>",
        "task_list": "<ul data-type=\"taskList\"><li data-type=\"taskItem\" data-checked=\"false\"><p>To do</p></li></ul>",
        "alignment": "style=\"text-align:center|right|justify\" on <p> and headings",
        "text_style": "<span style=\"color:#b42318;background-color:#fff3c4;font-size:18px;font-family:Georgia, serif;line-height:1.8\">…</span>",
        "highlight": "<mark style=\"background-color:#fde68a\">…</mark>",
        "allowed_css": ["color", "background-color", "font-size", "font-family", "line-height", "text-align",
                        "text-decoration", "width", "height", "max-width", "min-width", "vertical-align", "flex-basis"],
        "math": "Inline: <span data-type=\"math\" data-latex=\"E=mc^2\"></span>; display: add data-display=\"true\". "
                "Markdown input also accepts $…$ and $$…$$.",
        "links_to_kavot": "Note: <a href=\"/?view=notes&note_id=12\">; article: <a href=\"/?view=papers&paper_id=7\">",
    },
    "layout": {
        "callout": "<aside><p><strong>Note.</strong> …</p></aside>",
        "collapsible": "<details open><summary>Title</summary><p>Hidden content…</p></details>",
        "two_columns": "<div data-type=\"columns\"><div data-type=\"column\" style=\"flex-basis:60%\"><p>Left</p></div>"
                       "<div data-type=\"column\"><p>Right</p></div></div> (exactly two columns)",
        "section": "<section><h2>…</h2><p>…</p></section>",
        "table": "<table data-style=\"striped|minimal\" style=\"width:100%\"><tbody><tr><th>Head</th></tr><tr><td colspan=\"2\">…</td></tr></tbody></table>",
        "divider": "<hr data-style=\"thick|dashed|dotted|double|fade|ornament\">",
        "image": "<figure><img src=\"https://…\" alt=\"…\" style=\"width:60%\"><figcaption>Caption</figcaption></figure>",
        "media": "<video controls src=\"https://…\"></video> or <audio controls src=\"https://…\"></audio>",
    },
    "embeds": {
        "collection_view": {
            "html": "<div data-type=\"collection-view\" data-collection=\"tasks\" data-layout=\"table|list|gallery|kanban\" "
                    "data-config='{\"title\":\"Open tasks\",\"fields\":[\"status\",\"due_date\"],\"filters\":[{\"field\":\"status\",\"op\":\"not\",\"value\":\"Done\"}],"
                    "\"match\":\"all\",\"sort\":{\"field\":\"due_date\",\"dir\":\"asc\"},\"groupBy\":\"\",\"cover\":\"\",\"limit\":50,\"search\":true,\"wrap\":false}'></div>",
            "notes": "A live view of a collection (ids from list_collections). Filter ops: contains, equals, not, empty, "
                     "notEmpty, gt, lt. Field ids come from get_collection; \"title\" is always available.",
        },
        "script_block": {
            "tool": "note_script_set builds it for you (insert, or replace with block_id). Do not hand-write it.",
            "runtime": "HTML + CSS + JS (ES module) in a sandboxed iframe, re-run when the note opens. "
                       "Heights: " + ", ".join(SCRIPT_HEIGHTS) + " (px or auto).",
            "api": {
                "await kavot.collections()": "list of collections",
                "await kavot.items('tasks')": "items of a collection: {id, type, collection, title, detail, fields}",
                "await kavot.note()": "{title, text, words, headings:[{level, text, id}]} of the note",
                "kavot.scrollTo(id)": "scroll the note to a block id",
                "kavot.open(item)": "open an item returned by kavot.items",
                "kavot.toast('message')": "show a notification",
                "await kavot.fetch(url, options)": "like fetch, returns a Response; the user approves each new URL "
                                                   "(local and private addresses are refused)",
                "kavot.theme": "'light' or 'dark'",
            },
            "styling": "Theme CSS variables: var(--ink), var(--muted), var(--subtle), var(--line), var(--surface), "
                       "var(--surface-soft), var(--accent), var(--accent-soft), var(--red), var(--amber), var(--teal).",
            "limits": "No direct network (connect-src 'none'; use kavot.fetch), no workspace access: data only comes through kavot.*. "
                      "Libraries load with import from https://cdn.jsdelivr.net, https://unpkg.com, https://esm.sh "
                      "or https://cdnjs.cloudflare.com (e.g. import Chart from 'https://esm.sh/chart.js/auto').",
            "library": "Reusable scripts live in the script library (list_scripts, script_create/script_update/script_delete); "
                       "note_script_set with library_script_id copies one into a note.",
        },
    },
    "note_settings": {
        "presentation": "note_properties_update presentation: {\"width\": \"narrow|comfortable|wide\", \"theme\": \"paper|cream|slate\"}; omit theme to follow the app's light/dark theme, cream and slate stay light",
        "properties": "note_properties_update properties: free key/value metadata shown at the top of the note",
        "title_and_folder": "note_organize: title, project_id, folder_id",
    },
}


def script_block(name: str, html_code: str, css: str, js: str, height: str = "auto", block_id: str | None = None) -> str:
    """The exact markup the editor stores: inert <pre data-lang> elements holding escaped code."""
    parts = "".join(f'<pre data-lang="{lang}"><code>{html.escape(code, quote=False)}</code></pre>'
                    for lang, code in (("html", html_code), ("css", css), ("js", js)) if code)
    identity = f' id="{html.escape(block_id)}"' if block_id else ""
    return (f'<div data-type="script-block"{identity} data-script-name="{html.escape(name)}" '
            f'data-height="{html.escape(height)}">{parts}</div>')


def guide() -> dict:
    return {**GUIDE, "sanitizer_tags": sorted(html_documents.TAGS)}
