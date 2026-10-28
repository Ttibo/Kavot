"""Profiles of tabular data: what each column holds, in a few tokens.

The same profile describes a CSV file and the items of a collection, so an
agent sees the shape of the data (types, ranges, frequent values) before it
decides to read rows.
"""
from __future__ import annotations

import csv
import io
import json
import math
import re
from collections import Counter
from pathlib import Path
from typing import Any, Iterable

MAX_ROWS = 20_000
MAX_BYTES = 8_000_000
DATE = re.compile(r"^\d{4}-\d{2}-\d{2}")
SKIP = {"id", "created_at", "updated_at", "content", "file_name", "storage_path", "document_uid", "metadata"}


def _number(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value) if math.isfinite(value) else None
    if isinstance(value, str):
        try:
            number = float(value.replace(",", ".").strip())
        except ValueError:
            return None
        return number if math.isfinite(number) else None
    return None


def _short(value: Any, limit: int = 40) -> str:
    text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, default=str)
    text = " ".join(text.split())
    return text if len(text) <= limit else text[:limit - 1] + "…"


def column(values: list[Any]) -> dict[str, Any]:
    present = [v for v in values if v not in (None, "", [], {})]
    result: dict[str, Any] = {"filled": f"{len(present)}/{len(values)}"}
    if not present:
        result["type"] = "empty"
        return result
    if all(isinstance(v, bool) for v in present):
        counts = Counter(present)
        return {**result, "type": "boolean", "true": counts[True], "false": counts[False]}
    if all(isinstance(v, list) for v in present):
        tags = Counter(_short(item, 30) for v in present for item in v)
        return {**result, "type": "list", "top": [f"{k} ({n})" for k, n in tags.most_common(5)]}
    numbers = [n for n in map(_number, present) if n is not None]
    if len(numbers) >= 0.9 * len(present):
        mean = sum(numbers) / len(numbers)
        return {**result, "type": "number", "min": round(min(numbers), 4), "max": round(max(numbers), 4), "mean": round(mean, 4)}
    texts = [v for v in present if isinstance(v, str)]
    if texts and sum(bool(DATE.match(v)) for v in texts) >= 0.9 * len(present):
        dated = sorted(v[:10] for v in texts if DATE.match(v))
        return {**result, "type": "date", "from": dated[0], "to": dated[-1]}
    counts = Counter(_short(v) for v in present)
    result.update(type="text", distinct=len(counts))
    if len(counts) <= max(8, len(present) // 3):
        result["top"] = [f"{k} ({n})" for k, n in counts.most_common(5)]
    else:
        result["examples"] = [k for k, _ in counts.most_common(3)]
    return result


def rows(items: Iterable[dict[str, Any]], *, skip: set[str] = SKIP, columns: int = 24) -> dict[str, Any]:
    items = list(items)[:MAX_ROWS]
    names: list[str] = []
    for item in items:
        for key in item:
            if key not in names and key not in skip and not (skip and key.endswith(("_id", "_ids", "_at"))):
                names.append(key)
    profile = {name: column([item.get(name) for item in items]) for name in names[:columns]}
    return {"rows": len(items), "columns": profile, **({"more_columns": len(names) - columns} if len(names) > columns else {})}


def csv_file(path: Path) -> dict[str, Any]:
    raw = path.read_bytes()[:MAX_BYTES].decode("utf-8", errors="replace")
    sample = raw[:20_000]
    try:
        dialect = csv.Sniffer().sniff(sample, delimiters=",;\t|") if path.suffix.lower() != ".tsv" else csv.excel_tab
    except csv.Error:
        dialect = csv.excel
    reader = csv.DictReader(io.StringIO(raw), dialect=dialect)
    items = [row for _, row in zip(range(MAX_ROWS), reader)]
    profile = rows(items, skip=set())
    profile["sample"] = [{k: _short(v, 30) for k, v in list(row.items())[:8]} for row in items[:3]]
    if len(raw) >= MAX_BYTES or len(items) >= MAX_ROWS:
        profile["partial"] = "profile of the first rows only"
    return profile


def json_file(path: Path) -> dict[str, Any]:
    try:
        data = json.loads(path.read_bytes()[:MAX_BYTES])
    except ValueError:
        return {"structure": "invalid or truncated JSON"}
    if isinstance(data, list) and data and all(isinstance(item, dict) for item in data[:50]):
        return rows(data, skip=set())
    if isinstance(data, dict):
        return {"structure": "object", "keys": {k: type(v).__name__ + (f"[{len(v)}]" if isinstance(v, (list, dict)) else "")
                                               for k, v in list(data.items())[:30]}}
    return {"structure": type(data).__name__, "length": len(data) if isinstance(data, list) else None}
