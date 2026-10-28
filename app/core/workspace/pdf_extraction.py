"""Local PDF extraction. Page numbers are one-based; coordinates are PDF points."""
from __future__ import annotations

import json
import re
import subprocess
import tempfile
from collections import Counter
from pathlib import Path
from typing import Any

from app.core.workspace import image_ocr

CHUNK_SIZE = 1800
CHUNK_OVERLAP = 180
MAX_OCR_PIXELS = 20_000_000
HEADING = re.compile(r"^(?:\d+(?:\.\d+)*\.?\s+\S|abstract\b|introduction\b|conclusion[s]?\b|references\b|résumé\b|bibliographie\b)", re.I)


def passages(text: str, page: int, prefix: str, *, kind: str = "text", **context: Any) -> list[dict]:
    """Bounded, overlapping passages with exact offsets in their source text."""
    result = []
    start = 0
    while start < len(text):
        end = min(start + CHUNK_SIZE, len(text))
        if end < len(text):
            boundary = max(text.rfind("\n", start + CHUNK_SIZE // 2, end), text.rfind(" ", start + CHUNK_SIZE // 2, end))
            if boundary > start:
                end = boundary
        result.append({"id": f"{prefix}-c{len(result) + 1}", "page": page, "kind": kind,
                       "start": start, "end": end, "text": text[start:end], **context})
        if end == len(text):
            break
        start = max(start + 1, end - CHUNK_OVERLAP)
    return result


def table_markdown(rows: list[list]) -> str:
    width = max((len(row) for row in rows), default=0)
    lines = []
    for i, row in enumerate(rows):
        cells = [str(cell or "").replace("|", "\\|").replace("\n", "<br>") for cell in row]
        lines.append("| " + " | ".join(cells + [""] * (width - len(cells))) + " |")
        if i == 0:
            lines.append("| " + " | ".join(["---"] * width) + " |")
    return "\n".join(lines)


def _page_data(page: Any, number: int, *, ocr: bool = False) -> dict:
    page_id = f"p{number}-ocr" if ocr else f"p{number}"
    lines = page.extract_text_lines(return_chars=True)
    text = "\n".join(line["text"] for line in lines)
    sizes = Counter(round(char.get("size", 0), 1) for char in page.chars if char.get("text", "").strip())
    body_size = sizes.most_common(1)[0][0] if sizes else 0
    sections = []
    blocks = []
    offset = 0
    for line in lines:
        blocks.append({"text": line["text"], "start": offset, "end": offset + len(line["text"]),
                       "bbox": [line[key] for key in ("x0", "top", "x1", "bottom")]})
        title = line["text"].strip()
        chars = line.get("chars", [])
        size = max((char.get("size", 0) for char in chars), default=body_size)
        bold = bool(chars) and sum("bold" in char.get("fontname", "").lower() for char in chars) > len(chars) / 2
        if len(title) <= 180 and (HEADING.match(title) or (not ocr and body_size and (size >= body_size * 1.2 or bold))):
            sections.append({"id": f"{page_id}-s{len(sections) + 1}", "page": number, "title": title,
                             "start": offset, "method": "heuristic", "bbox": [line[key] for key in ("x0", "top", "x1", "bottom")]})
        offset += len(line["text"]) + 1
    for index, section in enumerate(sections):
        section["end"] = sections[index + 1]["start"] if index + 1 < len(sections) else len(text)
    tables = []
    errors = []
    try:
        found = page.find_tables()
        method = "lines"
        if not found:
            found = page.find_tables({"vertical_strategy": "text", "horizontal_strategy": "text", "min_words_vertical": 3})
            method = "text_alignment_heuristic"
        for table in found:
            rows = table.extract()
            nonempty = [row for row in rows if any(cell and str(cell).strip() for cell in row)]
            # Single-column prose is not a table. Text-aligned candidates remain explicitly heuristic.
            if len(nonempty) < 2 or max((sum(bool(cell) for cell in row) for row in nonempty), default=0) < 2:
                continue
            tables.append({"id": f"{page_id}-t{len(tables) + 1}", "page": number, "bbox": list(table.bbox),
                           "rows": rows, "markdown": table_markdown(rows), "method": method, "ocr": ocr})
    except Exception as error:
        errors.append(f"Table extraction failed: {type(error).__name__}")
    return {"page": number, "width": page.width, "height": page.height, "text": text,
            "method": "ocr" if ocr else "native", "blocks": blocks, "sections": sections, "tables": tables, "warnings": errors}


def _needs_ocr(page: Any, text: str) -> bool:
    # Short native title pages need no OCR; sparse text over a scan does.
    image_area = sum(max(0, item["x1"] - item["x0"]) * max(0, item["bottom"] - item["top"]) for item in page.images)
    return (not text.strip() and bool(page.images or page.curves or page.lines or page.rects)) or (image_area > page.width * page.height * 0.35) or "(cid:" in text or "\ufffd" in text


def _ocr_page(page: Any, number: int, capabilities: dict) -> dict:
    import pdfplumber

    if not capabilities["available"]:
        raise RuntimeError("OCR unavailable: install Tesseract and its language data, then rebuild this extraction.")
    # Limit rendered pixels without relying on external Poppler executables.
    dpi = min(220, max(1, int(72 * (MAX_OCR_PIXELS / max(1, page.width * page.height)) ** 0.5)))
    with tempfile.TemporaryDirectory(prefix="kavot-pdf-ocr-") as temporary:
        root = Path(temporary)
        rendered = page.to_image(resolution=dpi).original
        rendered.save(root / "page.png")
        rendered.close()
        result = subprocess.run([image_ocr.executable(), str(root / "page.png"), str(root / "ocr"),
                                 "-l", capabilities["default_language"], "--psm", "3", "pdf"],
                                capture_output=True, timeout=60, check=False)
        if result.returncode or not (root / "ocr.pdf").is_file():
            raise RuntimeError("Tesseract failed to extract this page.")
        with pdfplumber.open(root / "ocr.pdf") as document:
            extracted = _page_data(document.pages[0], number, ocr=True)
        if not extracted["text"].strip():
            raise RuntimeError("OCR detected no readable text on this page.")
        # Tesseract's output page size may differ slightly from the original.
        sx, sy = page.width / extracted["width"], page.height / extracted["height"]
        for item in [*extracted["blocks"], *extracted["sections"], *extracted["tables"]]:
            x0, top, x1, bottom = item["bbox"]
            item["bbox"] = [x0 * sx, top * sy, x1 * sx, bottom * sy]
        extracted.update(width=page.width, height=page.height, language=capabilities["default_language"])
        return extracted


def extract(path: Path) -> dict:
    """Preserve successful pages even when another page or the OCR engine fails."""
    payload: dict = {"status": "complete", "engine": "pdfplumber", "page_count": 0,
                     "pages": [], "sections": [], "tables": [], "passages": [], "warnings": [],
                     "chunking": {"max_characters": CHUNK_SIZE, "overlap_characters": CHUNK_OVERLAP,
                                  "offset_unit": "unicode_characters"},
                     "coordinates": {"unit": "pdf_points", "origin": "top_left", "page_numbering": "one_based"}}
    try:
        import pdfplumber

        payload["engine_version"] = pdfplumber.__version__
        capabilities = None
        with pdfplumber.open(path, unicode_norm="NFC") as document:
            payload["document_metadata"] = json.loads(json.dumps(document.metadata, default=str))
            payload["page_count"] = len(document.pages)
            for number, page in enumerate(document.pages, 1):
                extracted = {"page": number, "width": page.width, "height": page.height, "text": "",
                             "sections": [], "tables": [], "method": "failed", "warnings": []}
                try:
                    extracted = _page_data(page, number)
                    extracted["ocr_required"] = _needs_ocr(page, extracted["text"])
                    if extracted["ocr_required"]:
                        capabilities = capabilities or image_ocr.capabilities()
                        native_text = extracted["text"]
                        try:
                            ocr_data = _ocr_page(page, number, capabilities)
                            ocr_data.update(native_text=native_text, native_blocks=extracted["blocks"],
                                            native_sections=extracted["sections"], ocr_required=True)
                            # Keep native table cells as well as OCR candidates on mixed pages.
                            ocr_data["tables"] = [*extracted["tables"], *ocr_data["tables"]]
                            ocr_data["warnings"] = [*extracted["warnings"], *ocr_data["warnings"]]
                            extracted = ocr_data
                        except Exception as error:
                            extracted["warnings"].append(str(error))
                    extracted["status"] = "partial" if extracted["warnings"] else "complete"
                except Exception as error:
                    extracted["status"] = "failed"
                    extracted["warnings"].append(f"Page extraction failed: {type(error).__name__}: {error}")
                finally:
                    page.close()
                if extracted["status"] != "complete":
                    payload["status"] = "partial"
                payload["pages"].append(extracted)
                payload["sections"].extend(extracted["sections"])
                payload["tables"].extend(extracted["tables"])
                for chunk in passages(extracted["text"], number, f"p{number}"):
                    chunk["section_ids"] = [section["id"] for section in extracted["sections"] if section["start"] < chunk["end"] and section["end"] > chunk["start"]]
                    payload["passages"].append(chunk)
                if extracted.get("native_text") and extracted["native_text"] != extracted["text"]:
                    payload["passages"].extend(passages(extracted["native_text"], number, f"p{number}-native", kind="native_text"))
                for table in extracted["tables"]:
                    payload["passages"].extend(passages(table["markdown"], number, table["id"], kind="table", table_id=table["id"]))
        if not payload["pages"]:
            payload["status"] = "failed"
            payload["warnings"].append("The PDF contains no pages.")
    except Exception as error:
        payload["status"] = "partial" if payload["pages"] else "failed"
        payload["warnings"].append(f"PDF extraction failed: {type(error).__name__}: {error}")
    return payload
