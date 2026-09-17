"""Deterministic JSON reading and writing, validated against schemas/.

Every write validates first and fails closed: if the document doesn't match
its schema, nothing touches the disk. Writes are atomic and skipped when the
bytes on disk already match, so a run with no new data changes no files.
"""

from __future__ import annotations

import json
import os
import re
import tempfile
from datetime import datetime
from decimal import Decimal
from pathlib import Path
from urllib.parse import urlsplit

from jsonschema import Draft202012Validator, FormatChecker

from .paths import SCHEMAS_DIR

SCHEMA_FILES = {
    "aaa-daily": "aaa-daily.schema.json",
    "eia-diesel-weekly": "eia-diesel-weekly.schema.json",
    "latest": "latest.schema.json",
}

_DATE_TIME = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$")


class SchemaError(ValueError):
    """A document failed schema validation. Nothing was written."""


def _format_checker() -> FormatChecker:
    checker = FormatChecker()

    # jsonschema only checks these formats when optional packages are
    # installed, so register small strict checkers of our own.
    @checker.checks("date-time", raises=ValueError)
    def _is_date_time(instance):
        if not isinstance(instance, str):
            return True
        if not _DATE_TIME.match(instance):
            return False
        datetime.fromisoformat(instance.replace("Z", "+00:00"))
        return True

    @checker.checks("uri", raises=ValueError)
    def _is_uri(instance):
        if not isinstance(instance, str):
            return True
        parts = urlsplit(instance)
        return bool(parts.scheme and parts.netloc)

    return checker


class Validators:
    def __init__(self, schemas_dir: Path | str = SCHEMAS_DIR):
        self._validators = {}
        checker = _format_checker()
        for kind, filename in SCHEMA_FILES.items():
            with open(Path(schemas_dir) / filename, encoding="utf-8") as f:
                schema = json.load(f)
            Draft202012Validator.check_schema(schema)
            self._validators[kind] = Draft202012Validator(schema, format_checker=checker)

    def errors(self, kind: str, doc) -> list[str]:
        v = self._validators[kind]
        out = []
        for err in sorted(v.iter_errors(doc), key=lambda e: list(e.absolute_path)):
            where = "/".join(str(p) for p in err.absolute_path) or "(root)"
            out.append(f"{where}: {err.message}")
        return out

    def validate(self, kind: str, doc) -> None:
        errs = self.errors(kind, doc)
        if errs:
            shown = "; ".join(errs[:5])
            more = f" (and {len(errs) - 5} more)" if len(errs) > 5 else ""
            raise SchemaError(f"{kind} failed schema validation: {shown}{more}")


_default: Validators | None = None


def validators() -> Validators:
    global _default
    if _default is None:
        _default = Validators()
    return _default


def num(value: Decimal | float | int) -> float:
    """Money value for JSON. Decimal in, shortest float repr out, never -0.0."""
    f = float(value)
    return 0.0 if f == 0 else f


def dec(value) -> Decimal:
    """Exact Decimal from a JSON number (float) or string, never via binary float math."""
    if isinstance(value, Decimal):
        return value
    if isinstance(value, bool):
        raise TypeError("bool is not a price")
    if isinstance(value, float):
        return Decimal(repr(value))
    return Decimal(str(value))


def dumps(doc) -> str:
    return json.dumps(doc, indent=2, ensure_ascii=False) + "\n"


def dumps_eia_weekly(doc) -> str:
    """Like dumps, but each week object sits on one line so git diffs stay readable."""
    lines = ["{"]
    keys = list(doc.keys())
    for i, key in enumerate(keys):
        comma = "," if i < len(keys) - 1 else ""
        if key == "weeks":
            lines.append('  "weeks": [')
            weeks = doc["weeks"]
            for j, week in enumerate(weeks):
                wcomma = "," if j < len(weeks) - 1 else ""
                lines.append("    " + json.dumps(week, ensure_ascii=False, separators=(", ", ": ")) + wcomma)
            lines.append("  ]" + comma)
        else:
            lines.append(f"  {json.dumps(key)}: {json.dumps(doc[key], ensure_ascii=False)}{comma}")
    lines.append("}")
    return "\n".join(lines) + "\n"


def read_json(path: Path | str):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def read_text(path: Path | str) -> str | None:
    try:
        with open(path, encoding="utf-8") as f:
            return f.read()
    except FileNotFoundError:
        return None


def write_text_if_changed(path: Path | str, text: str) -> bool:
    """Atomically write text. Returns False and leaves the file alone if it already matches."""
    path = Path(path)
    if read_text(path) == text:
        return False
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as f:
            f.write(text)
        # mkstemp creates 0600 files. Data files are meant to be world readable.
        umask = os.umask(0)
        os.umask(umask)
        os.chmod(tmp, 0o666 & ~umask)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except FileNotFoundError:
            pass
        raise
    return True


def write_doc(kind: str, path: Path | str, doc, v: Validators | None = None) -> bool:
    """Validate then write. Raises SchemaError (and writes nothing) on a bad document."""
    (v or validators()).validate(kind, doc)
    text = dumps_eia_weekly(doc) if kind == "eia-diesel-weekly" else dumps(doc)
    # Belt and braces: what we write must parse back to the same document.
    if json.loads(text) != json.loads(json.dumps(doc)):
        raise SchemaError(f"{kind} did not round trip through JSON")
    return write_text_if_changed(path, text)
