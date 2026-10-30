"""Read-only previews of documents in a linked folder: Word, Excel, PowerPoint, CSV.

Office files are zip archives of XML parts; only their text and table structure is
extracted, with size limits, so a preview never runs anything from the document.
"""
from __future__ import annotations

import csv
import io
import re
import zipfile
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any
from xml.etree import ElementTree

from fastapi import HTTPException

MAX_DOCUMENT = 50_000_000
MAX_PART = 20_000_000
MAX_BLOCKS = 3000
MAX_ROWS = 500
MAX_COLUMNS = 60
MAX_SHEETS = 8

# Files a preview reads, files served as they are (shown in a frame), files the system may open.
PREVIEWS = {".docx", ".xlsx", ".xlsm", ".pptx", ".csv", ".tsv"}
RAW = {".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
       ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp"}
DOCUMENTS = {".docx", ".doc", ".odt", ".rtf", ".xlsx", ".xlsm", ".xls", ".ods", ".csv", ".tsv", ".pptx", ".ppt", ".odp",
             ".pdf", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg", ".txt", ".md", ".json", ".xml", ".yaml", ".yml",
             ".mp3", ".wav", ".mp4", ".mov", ".zip", ".ipynb", ".tex", ".bib"}

W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
S = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
R = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
A = "{http://schemas.openxmlformats.org/drawingml/2006/main}"
# "Strict" Office files use other namespaces for the same elements.
STRICT = {b"http://purl.oclc.org/ooxml/wordprocessingml/main": b"http://schemas.openxmlformats.org/wordprocessingml/2006/main",
          b"http://purl.oclc.org/ooxml/spreadsheetml/main": b"http://schemas.openxmlformats.org/spreadsheetml/2006/main",
          b"http://purl.oclc.org/ooxml/officeDocument/relationships": b"http://schemas.openxmlformats.org/officeDocument/2006/relationships",
          b"http://purl.oclc.org/ooxml/drawingml/main": b"http://schemas.openxmlformats.org/drawingml/2006/main"}
# Built-in number formats of Excel that show dates or times.
DATE_FORMATS = {14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47}
WRAPPERS = {f"{W}sdt", f"{W}sdtContent", f"{W}customXml", f"{W}smartTag", f"{W}ins", f"{W}txbxContent"}


def _part(archive: zipfile.ZipFile, name: str) -> ElementTree.Element | None:
    try:
        info = archive.getinfo(name)
    except KeyError:
        return None
    if info.file_size > MAX_PART:
        raise HTTPException(422, "This document is too large to preview.")
    data = archive.read(info)
    for strict, transitional in STRICT.items():
        data = data.replace(strict, transitional)
    return ElementTree.fromstring(data)


def _docx(archive: zipfile.ZipFile) -> dict[str, Any]:
    root = _part(archive, "word/document.xml")
    if root is None:
        raise HTTPException(422, "This Word document has no readable content.")
    body = root.find(f"{W}body")
    blocks: list[dict[str, Any]] = []

    def text(element) -> str:
        return "".join(node.text or "" for node in element.iter(f"{W}t"))

    def children(container):
        # Content controls and similar wrappers hold ordinary paragraphs and tables.
        for child in container:
            if child.tag in WRAPPERS:
                yield from children(child)
            else:
                yield child

    for child in children(body) if body is not None else []:
        if len(blocks) >= MAX_BLOCKS:
            break
        if child.tag == f"{W}p":
            content = text(child).strip()
            if not content:
                continue
            style = child.find(f"{W}pPr/{W}pStyle")
            name = (style.get(f"{W}val") if style is not None else "") or ""
            heading = re.match(r"(?i)^(?:heading|titre)\s*(\d)$", name)
            level = int(heading.group(1)) if heading else 1 if name.lower() == "title" else 0
            if level:
                blocks.append({"type": "heading", "level": min(level, 4), "text": content})
            elif child.find(f"{W}pPr/{W}numPr") is not None:
                blocks.append({"type": "item", "text": content})
            else:
                blocks.append({"type": "paragraph", "text": content})
        elif child.tag == f"{W}tbl":
            rows = [[text(cell).strip() for cell in row.findall(f"{W}tc")][:MAX_COLUMNS] for row in child.findall(f"{W}tr")[:MAX_ROWS]]
            blocks.append({"type": "table", "rows": rows})
    return {"kind": "document", "blocks": blocks, "truncated": len(blocks) >= MAX_BLOCKS}


def _column(reference: str) -> int:
    index = 0
    for letter in re.match(r"[A-Z]*", reference).group(0):
        index = index * 26 + ord(letter) - 64
    return max(0, index - 1)


def _xlsx(archive: zipfile.ZipFile) -> dict[str, Any]:
    workbook = _part(archive, "xl/workbook.xml")
    relations = _part(archive, "xl/_rels/workbook.xml.rels")
    if workbook is None or relations is None:
        raise HTTPException(422, "This spreadsheet has no readable sheet.")
    targets = {item.get("Id"): item.get("Target") for item in relations}
    dates = _date_styles(archive)
    strings_root = _part(archive, "xl/sharedStrings.xml")
    strings = ["".join(node.text or "" for node in item.iter(f"{S}t")) for item in strings_root.findall(f"{S}si")] if strings_root is not None else []
    sheets = []
    for sheet in workbook.iter(f"{S}sheet"):
        if len(sheets) >= MAX_SHEETS:
            break
        target = (targets.get(sheet.get(f"{R}id")) or "").lstrip("/")
        path = target if target.startswith("xl/") else f"xl/{target}"
        root = _part(archive, path)
        rows: list[list[str]] = []
        truncated = False
        for row in root.iter(f"{S}row") if root is not None else []:
            if len(rows) >= MAX_ROWS:
                truncated = True
                break
            values: list[str] = []
            for cell in row.findall(f"{S}c"):
                column = _column(cell.get("r") or "")
                if column >= MAX_COLUMNS:
                    continue
                kind, value = cell.get("t"), cell.find(f"{S}v")
                if kind == "s" and value is not None and (value.text or "").isdigit() and int(value.text) < len(strings):
                    content = strings[int(value.text)]
                elif kind == "inlineStr":
                    content = "".join(node.text or "" for node in cell.iter(f"{S}t"))
                else:
                    content = value.text if value is not None and value.text else ""
                    if content and kind in {None, "n"} and (cell.get("s") or "0").isdigit() and int(cell.get("s") or 0) in dates:
                        content = _date(content)
                values += [""] * (column - len(values))
                values.append(content)
            rows.append(values)
        sheets.append({"name": sheet.get("name") or f"Sheet {len(sheets) + 1}", "rows": rows, "truncated": truncated})
    return {"kind": "spreadsheet", "sheets": sheets}


def _date_styles(archive: zipfile.ZipFile) -> set[int]:
    """Indexes of the cell styles that show a date (built-in or custom date formats)."""
    styles = _part(archive, "xl/styles.xml")
    if styles is None:
        return set()
    custom = set()
    for item in styles.iter(f"{S}numFmt"):
        code = re.sub(r'"[^"]*"|\[[^\]]*\]', "", (item.get("formatCode") or "").lower())
        if re.search(r"[dy]|m{3,}|h", code) and (item.get("numFmtId") or "").isdigit():
            custom.add(int(item.get("numFmtId")))
    cells = styles.find(f"{S}cellXfs")
    return {index for index, xf in enumerate(cells if cells is not None else [])
            if (xf.get("numFmtId") or "0").isdigit() and int(xf.get("numFmtId") or 0) in DATE_FORMATS | custom}


def _date(serial: str) -> str:
    try:
        moment = datetime(1899, 12, 30) + timedelta(days=float(serial))
    except (ValueError, OverflowError):
        return serial
    return moment.strftime("%Y-%m-%d %H:%M" if moment.hour or moment.minute else "%Y-%m-%d")


def text(path: Path, limit: int = 15_000) -> str:
    """The text of a document, for an agent that reads it (Office files, CSV, plain text)."""
    suffix = path.suffix.lower()
    if suffix in PREVIEWS:
        content = preview(path)
        if content["kind"] == "document":
            lines = []
            for block in content["blocks"]:
                lines += ["\t".join(row) for row in block["rows"]] if block["type"] == "table" else [("#" * block.get("level", 0) + " " if block["type"] == "heading" else "") + block["text"]]
        elif content["kind"] == "slides":
            lines = [f"Slide {index + 1}: " + " / ".join(slide) for index, slide in enumerate(content["slides"])]
        else:
            lines = [line for sheet in content["sheets"] for line in [f"## {sheet['name']}", *("\t".join(row) for row in sheet["rows"])]]
        return "\n".join(lines)[:limit]
    raw = path.read_bytes()[:limit * 4]
    if b"\0" in raw[:4096]:
        raise HTTPException(422, "This file is not text.")
    return raw.decode("utf-8", errors="replace")[:limit]


def _pptx(archive: zipfile.ZipFile) -> dict[str, Any]:
    names = sorted((name for name in archive.namelist() if re.fullmatch(r"ppt/slides/slide\d+\.xml", name)),
                   key=lambda name: int(re.search(r"\d+", name.rsplit("/", 1)[1]).group(0)))
    slides = []
    for name in names[:200]:
        root = _part(archive, name)
        paragraphs = ["".join(node.text or "" for node in paragraph.iter(f"{A}t")).strip() for paragraph in root.iter(f"{A}p")] if root is not None else []
        slides.append([text for text in paragraphs if text])
    return {"kind": "slides", "slides": slides, "truncated": len(names) > 200}


def _table(path: Path) -> dict[str, Any]:
    raw = path.read_bytes()[:5_000_000]
    text = raw.decode("utf-8-sig", errors="replace")
    try:
        dialect = csv.Sniffer().sniff(text[:20_000], delimiters=",;\t|")
    except csv.Error:
        dialect = csv.excel_tab if path.suffix.lower() == ".tsv" else csv.excel
    rows, truncated = [], False
    for row in csv.reader(io.StringIO(text), dialect):
        if len(rows) >= MAX_ROWS:
            truncated = True
            break
        rows.append(row[:MAX_COLUMNS])
    return {"kind": "spreadsheet", "sheets": [{"name": path.name, "rows": rows, "truncated": truncated}]}


def preview(path: Path) -> dict[str, Any]:
    suffix = path.suffix.lower()
    if suffix not in PREVIEWS:
        raise HTTPException(422, "No preview for this kind of file.")
    if path.stat().st_size > MAX_DOCUMENT:
        raise HTTPException(422, "This document is too large to preview.")
    if suffix in {".csv", ".tsv"}:
        return _table(path)
    try:
        with zipfile.ZipFile(path) as archive:
            return {".docx": _docx, ".pptx": _pptx}.get(suffix, _xlsx)(archive)
    except (zipfile.BadZipFile, ElementTree.ParseError, KeyError, ValueError):
        raise HTTPException(422, "This document could not be read.") from None
