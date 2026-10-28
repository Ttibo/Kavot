"""Portable, inert HTML documents. The file owns content and document metadata.

API fragments use application URLs; disk documents use relative URLs with stable
reference attributes. JSON metadata is data, never executable script.
"""
from __future__ import annotations

import copy
import functools
import hashlib
import html
import json
import os
import re
import uuid
from pathlib import Path
from urllib.parse import parse_qs, quote, unquote, urlsplit

import bleach
from bleach.css_sanitizer import CSSSanitizer
from bs4 import BeautifulSoup
from markdown_it import MarkdownIt
from mdit_py_plugins.dollarmath import dollarmath_plugin
from mdit_py_plugins.tasklists import tasklists_plugin
from latex2mathml.converter import convert as mathml

from app.core.kernel.config import settings

CSS = '''body{margin:0;background:#fff;color:#222;font:16px/1.65 system-ui,sans-serif}
article{max-width:960px;margin:auto;padding:40px}img,video{max-width:100%;height:auto}
table{border-collapse:separate;border-spacing:0;width:100%;table-layout:fixed;border:1px solid #e3e2dc;border-radius:8px;overflow:hidden;font-size:.95em}
td,th{border:0;border-right:1px solid #ecebe5;border-bottom:1px solid #ecebe5;padding:9px 12px;vertical-align:top;overflow-wrap:anywhere;text-align:left}
th{background:#f6f5f1;color:#55574f;font-weight:600}tr>:last-child{border-right:0}tr:last-child>td,tr:last-child>th{border-bottom:0}
table[data-style=striped] tbody tr:nth-child(even) td{background:#fafaf7}table[data-style=minimal]{border:0;border-radius:0}table[data-style=minimal] :is(td,th){border-right:0}
hr{border:0;border-top:1px solid #d6d5cf;margin:24px 0}hr[data-style=thick]{border-top-width:3px}hr[data-style=dashed]{border-top-style:dashed}hr[data-style=dotted]{border-top-style:dotted;border-top-width:2px}hr[data-style=double]{border-top:4px double #d6d5cf}hr[data-style=fade]{border:0;height:1px;background:linear-gradient(90deg,transparent,#087e86,transparent)}hr[data-style=ornament]{border:0;text-align:center;color:#999}hr[data-style=ornament]::after{content:"✦  ✦  ✦";white-space:pre}
[data-type=script-block],[data-type=collection-view]{border:1px dashed #cfcfc8;border-radius:8px;padding:10px 14px;margin:16px 0;color:#666}
[data-type=script-block]::before{content:"Script: " attr(data-script-name);font-weight:600;display:block}[data-type=collection-view]::before{content:"Collection view: " attr(data-collection);font-weight:600}
pre{white-space:pre-wrap;background:#f4f4f4;padding:16px}blockquote,aside{border-left:4px solid #087e86;padding:12px 20px;background:#f4f7f7}
[data-type=columns]{display:flex;gap:24px;align-items:flex-start}[data-type=column]{flex:1;min-width:0}[data-type=column][style*=flex-basis]{flex-grow:0}
figure{margin:16px 0}figcaption{color:#666;font-size:.9em}dl{display:grid;grid-template-columns:auto 1fr;gap:4px 18px}dd{margin:0}
[data-kavot-generated]{border-bottom:1px solid #ddd;margin-bottom:24px}a{color:#087e86}math{font-size:1.1em}
@media(max-width:650px){article{padding:20px}[data-type=columns]{flex-direction:column}[data-type=column]{width:100%}}
@media print{article{max-width:none;padding:0}details>*{display:block}a{color:inherit}pre,figure,tr{break-inside:avoid}}
'''
TAGS = set('p h1 h2 h3 h4 h5 h6 section div span aside figure figcaption img a strong b em i u s del mark sub sup br hr blockquote pre code ul ol li table thead tbody tfoot tr th td colgroup col details summary input audio video source math mrow mi mn mo ms mtext mspace msup msub msubsup mfrac msqrt mroot munder mover munderover mtable mtr mtd semantics annotation'.split())
ATTRS = set('id class title href src alt width height colspan rowspan colwidth start checked disabled type controls preload open style display xmlns mathvariant encoding'.split())
DATA = {'data-type', 'data-kavot-block', 'data-kavot-href', 'data-kavot-src', 'data-kavot-target', 'data-latex', 'data-display', 'data-width', 'data-align', 'data-checked',
        'data-lang', 'data-script-name', 'data-height', 'data-collection', 'data-layout', 'data-config', 'data-style'}
STYLE = CSSSanitizer(allowed_css_properties=['color', 'background-color', 'font-size', 'font-family', 'line-height', 'text-align', 'text-decoration', 'width', 'height', 'max-width', 'min-width', 'vertical-align', 'flex-basis'])

def is_html(value: str) -> bool:
    return bool(re.search(r'<(?:!doctype|html\b|p\b|h[1-6]\b|div\b|section\b|table\b|figure\b|ul\b|ol\b|blockquote\b|pre\b|img\b|span\b|aside\b|details\b|hr\b|a\b|strong\b|em\b|math\b|audio\b|video\b)', value, re.I))

def _math(source, options=None, *, display_mode=False):
    display_mode = (options or {}).get('display_mode', display_mode)
    try:
        rendered = mathml(source, display='block' if display_mode else 'inline')
    except Exception:
        rendered = html.escape(source)
    return f'<span data-type="math" data-latex="{html.escape(source, quote=True)}" data-display="{str(display_mode).lower()}">{rendered}</span>'

def sanitize(value: str) -> str:
    soup = BeautifulSoup(value, 'html.parser')
    for node in soup.select('script, style, iframe, object, embed, form, base, link'):
        node.decompose()
    return bleach.clean(str(soup), tags=TAGS, attributes=lambda tag, name, value: name in ATTRS or name in DATA,
                        protocols={'http', 'https', 'mailto'}, css_sanitizer=STYLE, strip=True)

def fragment(value: str, *, identify=True, markdown=False) -> str:
    value = str(value or '')
    soup = BeautifulSoup(value, 'html.parser') if not markdown and is_html(value) else None
    if soup is not None:
        content = soup.select_one('[data-kavot-content]')
        value = content.decode_contents() if content else soup.body.decode_contents() if soup.body else value
    else:
        parser = MarkdownIt('commonmark', {'html': False}).enable(['table', 'strikethrough'])
        parser.use(dollarmath_plugin, renderer=_math).use(tasklists_plugin)
        value = parser.render(value)
    soup = BeautifulSoup(sanitize(value), 'html.parser')
    # Formulas written as LaTeX only (e.g. by an agent) get their MathML rendering.
    for node in soup.select('span[data-type="math"][data-latex]'):
        if node.find('math') is None:
            rendered = BeautifulSoup(_math(node['data-latex'], display_mode=node.get('data-display') == 'true'), 'html.parser').span
            node.clear()
            for child in list(rendered.contents):
                node.append(child)
    if identify:
        seen = set()
        # Script blocks and collection views are single blocks for the editor: what they hold
        # (the code's <pre data-lang>) carries no block id, or the editor's copy never matches the saved one.
        for inner in soup.select(':is(div[data-type="script-block"], div[data-type="collection-view"]) [id]'):
            del inner['id']
        for node in soup.select('p,h1,h2,h3,h4,h5,h6,section,figure,figcaption,img,table,tr,td,th,blockquote,pre,ul,ol,li,aside,details,summary,hr,audio,video,div[data-type],span[data-type="math"]'):
            if node.find_parent('div', attrs={'data-type': ['script-block', 'collection-view']}):
                continue
            key = node.get('id')
            if not key or key in seen:
                key = 'b-' + uuid.uuid4().hex
                node['id'] = key
            seen.add(key)
    return str(soup)

def fingerprint(path: Path) -> str | None:
    return hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None

def metadata(source: str) -> dict:
    return copy.deepcopy(_metadata(source))

@functools.lru_cache(maxsize=1024)
def _metadata(source: str) -> dict:
    node = BeautifulSoup(source, 'html.parser').find('script', id='kavot-metadata', type='application/json')
    try:
        data = json.loads(node.string or '{}') if node else {}
        if not isinstance(data, dict):
            return {}
        for key in ('properties', 'presentation'):
            if key in data and not isinstance(data[key], dict):
                data[key] = {}
        return data
    except (ValueError, TypeError):
        return {}

def _target(url: str, note: dict, state: dict) -> Path | None:
    from app.core.workspace import documents
    from app.plugins.papers import library
    parsed = urlsplit(url)
    paper_file = re.fullmatch(r'/api/papers/(\d+)/file', parsed.path)
    if paper_file:
        try:
            return library.pdf_path(int(paper_file[1]))
        except Exception:
            return None
    if url.startswith('#note-'):
        other = next((n for n in state['notes'] if str(n['id']) == url[6:]), None)
        return documents.note_path(other, state).with_suffix('.html') if other else None
    if url.startswith(('#paper-', '#pdf-external-')):
        try:
            return library.pdf_path(int(url.rsplit('-', 1)[-1]))
        except Exception:
            return None
    if parsed.path == '/api/workspace/file':
        path = parse_qs(parsed.query).get('path', [''])[0]
        target = settings.storage_path / path if path else None
        if target and target.suffix == '.md':
            for other in state.get('notes', []):
                if documents.note_path(other, state).with_suffix('.md').resolve() == target.resolve():
                    return target.with_suffix('.html')
            if not target.exists() and target.with_suffix('.html').exists():
                return target.with_suffix('.html')
        return target
    if parsed.path.startswith('/api/databases/resources/files/'):
        return settings.databases_path / 'resources/files' / unquote(parsed.path.rsplit('/', 1)[-1])
    match = re.fullmatch(r'/api/notes/(\d+)/assets/(.+)', parsed.path)
    if match:
        return documents.asset_path(int(match[1]), unquote(match[2]))
    if url.startswith('assets/'):
        return documents.note_path(note, state).parent / unquote(url)
    return None

def portable(content: str, path: Path, note: dict, state: dict) -> str:
    soup = BeautifulSoup(content, 'html.parser')
    for node in soup.find_all(True):
        for attr in ('href', 'src'):
            url = node.get(attr)
            if not url:
                continue
            target = _target(url, note, state)
            if target and target.resolve().is_relative_to(settings.storage_path.resolve()):
                node['data-kavot-' + attr] = url
                node[attr] = quote(os.path.relpath(target, path.parent).replace('\\', '/'), safe='/.-_')
    return str(soup)

def read(source: str, path: Path | None = None) -> str:
    # Listing notes re-reads every document; parsing and sanitizing dominate.
    return _read(source, path, settings.storage_path)

@functools.lru_cache(maxsize=1024)
def _read(source: str, path: Path | None, storage: Path) -> str:
    soup = BeautifulSoup(fragment(source), 'html.parser')
    for node in soup.find_all(True):
        for attr in ('href', 'src'):
            original = node.get('data-kavot-' + attr)
            if original:
                node[attr] = original
                del node['data-kavot-' + attr]
            elif path and node.get(attr) and not urlsplit(node[attr]).scheme and not node[attr].startswith(('/', '#')):
                parts = urlsplit(node[attr])
                target = (path.parent / unquote(parts.path)).resolve()
                if target.suffix == '.md' and not target.exists() and target.with_suffix('.html').exists():
                    target = target.with_suffix('.html')
                if target.is_relative_to(settings.storage_path.resolve()):
                    node[attr] = '/api/workspace/file?path=' + quote(target.relative_to(settings.storage_path.resolve()).as_posix(), safe='') + ('#' + parts.fragment if parts.fragment else '')
            parsed = urlsplit(node.get(attr, ''))
            if parsed.path == '/api/workspace/file':
                relative = parse_qs(parsed.query).get('path', [''])[0]
                target = (settings.storage_path / relative).resolve()
                if target.is_relative_to(settings.storage_path.resolve()) and target.suffix == '.md' and not target.exists() and target.with_suffix('.html').exists():
                    node[attr] = '/api/workspace/file?path=' + quote(target.with_suffix('.html').relative_to(settings.storage_path.resolve()).as_posix(), safe='') + ('#' + parsed.fragment if parsed.fragment else '')
    return sanitize(str(soup))

def serialize(note: dict, content: str, path: Path, state: dict) -> str:
    note.setdefault('document_uid', str(uuid.uuid4()))
    fields = ('document_uid', 'title', 'created_at', 'updated_at', 'properties', 'presentation', 'project_id', 'paper_id', 'folder_id', 'template_id', 'resource_id', 'source_image_path', 'drawing', 'drawing_preview', 'zotero_notes', 'zotero_folder_ids', 'article_pdf_links_version', 'system_kind')
    meta = {k: note[k] for k in fields if k in note}
    meta.update(schema_version=1, kind='note', legacy_id=note.get('id'))
    encoded = json.dumps(meta, ensure_ascii=False, indent=2).replace('<', '\\u003c').replace('>', '\\u003e').replace('&', '\\u0026')
    title = html.escape(str(note.get('title') or 'Document'))
    props = ''.join(f'<dt>{html.escape(str(k))}</dt><dd>{html.escape(str(v))}</dd>' for k, v in (note.get('properties') or {}).items())
    body = portable(fragment(content), path, note, state)
    preview = str(note.get('drawing_preview') or '')
    drawing = ''
    if re.fullmatch(r'data:image/png;base64,[A-Za-z0-9+/=]+', preview):
        drawing = f'<figure data-kavot-generated="drawing"><img alt="{title}" src="{preview}"></figure>'
    presentation = note.get('presentation') or {}
    width = {'narrow': '700px', 'comfortable': '960px', 'wide': '1400px'}.get(presentation.get('width'), '960px')
    theme = {'paper': '#fff', 'cream': '#fffaf0', 'slate': '#eef3f7'}.get(presentation.get('theme'), '#fff')
    style = CSS + f'body{{background:{theme}}}article{{max-width:{width}}}'
    return f'<!doctype html>\n<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="kavot-format" content="document/1"><title>{title}</title>\n<script type="application/json" id="kavot-metadata">{encoded}</script>\n<style>{style}</style></head>\n<body><article><header data-kavot-generated="properties"><h1>{title}</h1><dl>{props}</dl></header>{drawing}\n<main data-kavot-content>{body}</main></article></body></html>\n'

def insert(content: str, addition: str, cursor: int) -> str:
    """Insert at a complete top-level block boundary (UTF-16 API offset)."""
    content = fragment(content)
    position = len(content.encode('utf-16-le')[:max(0, cursor) * 2].decode('utf-16-le', errors='ignore'))
    soup = BeautifulSoup(content, 'html.parser')
    offset = 0
    for node in list(soup.contents):
        offset += len(str(node))
        if offset >= position:
            for extra in reversed(list(BeautifulSoup(fragment(addition), 'html.parser').contents)):
                node.insert_after(extra)
            return str(soup)
    return content + fragment(addition)


def generated(title: str, markdown: str, path: Path, state: dict) -> str:
    """Stable bytes for generated views: rendering does not create new identities."""
    body = BeautifulSoup(fragment(markdown, identify=False, markdown=True), 'html.parser')
    for index, node in enumerate(body.find_all(True)):
        if node.name in {'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'tr', 'td', 'th', 'ul', 'ol', 'li', 'pre', 'blockquote', 'div', 'section', 'img', 'figure', 'figcaption', 'aside', 'details', 'summary', 'hr', 'audio', 'video'} or node.get('data-type') == 'math':
            node['id'] = f'generated-{index}'
    return serialize({'title': title, 'document_uid': str(uuid.uuid5(uuid.NAMESPACE_URL, path.relative_to(settings.storage_path).as_posix()))}, str(body), path, state)


def semantic(value: str) -> str:
    """Compare imported blocks independently of editor whitespace/identifiers."""
    soup = BeautifulSoup(fragment(value, identify=False), 'html.parser')
    for node in soup.find_all(True):
        node.attrs.pop('id', None)
    for text in list(soup.find_all(string=True)):
        if not text.find_parent(['p', 'li', 'td', 'th', 'h1', 'h2', 'h3', 'pre', 'code']) and not str(text).strip():
            text.extract()
    return str(soup)
