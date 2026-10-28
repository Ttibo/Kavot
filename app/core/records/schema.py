"""Validation of user-defined collection metadata."""
from datetime import date, datetime
import math
import re
from urllib.parse import urlparse

from fastapi import HTTPException

EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def field_value_error(field, value):
    """Return why a non-empty value does not fit the field, or None when it is valid."""
    kind = field.get("type", "text")
    valid = True
    if kind == "number":
        valid = type(value) in (int, float) and math.isfinite(value)
    elif kind == "boolean":
        valid = type(value) is bool
    elif kind == "list":
        valid = isinstance(value, list) and all(isinstance(row, dict) for row in value)
        if valid:
            columns = {column["id"]: column for column in field.get("columns", [])}
            for row in value:
                for key, cell in row.items():
                    column = columns.get(key)
                    if column is None:
                        return f"Unknown column {key} in {field['name']}."
                    if cell is None or cell == "" or (error := field_value_error(column, cell)) is None:
                        continue
                    return f"Invalid value in {field['name']} → {column['name']} ({column.get('type', 'text')})."
    elif kind in {"tags", "relation"}:
        valid = isinstance(value, list)
        if kind == "tags" and valid:
            valid = all(isinstance(tag, str) for tag in value)
    elif kind != "json":
        valid = isinstance(value, str)
        if valid and kind in {"date", "datetime"}:
            try:
                (date if kind == "date" else datetime).fromisoformat(value)
            except ValueError:
                valid = False
        if valid and kind == "url":
            try:
                parsed = urlparse(value)
                valid = parsed.scheme in {"http", "https"} and bool(parsed.netloc)
            except ValueError:
                valid = False
        if valid and kind == "email":
            valid = bool(EMAIL.fullmatch(value))
        if valid and kind == "select":
            valid = value in field.get("options", [])
    return None if valid else f"Invalid value for {field['name']} ({kind})."


def validate_values(database, values):
    for field in database.get("fields", []):
        value = values.get(field["id"])
        empty = value is None or value == "" or value == [] or isinstance(value, str) and not value.strip()
        if empty:
            if field.get("required"):
                raise HTTPException(422, f"The {field['name']} field is required.")
            continue
        if error := field_value_error(field, value):
            raise HTTPException(422, error)


def initial_values(database):
    """Values a new item starts with: the content template and each field's default."""
    values = {"content": database.get("content_template", "")}
    for field in database.get("fields", []):
        if field.get("default") is not None:
            values[field["id"]] = field["default"]
    return values
