"""Minimal JSON Schema (2020-12 subset) validator.

Covers exactly the keywords used by SPECS/config.schema.json, so scenario
validation works offline with no third-party dependency. Errors carry the
field path and the violated constraint (docs/ARCHITECTURE.md, loader).
"""
from __future__ import annotations

import json
import re
from pathlib import Path


def _load_schema_text() -> str:
    here = Path(__file__).resolve()
    for parent in here.parents:
        cand = parent / "SPECS" / "config.schema.json"
        if cand.is_file():
            return cand.read_text(encoding="utf-8")
    return (here.parent / "config.schema.json").read_text(encoding="utf-8")


_SCHEMA = None


def config_schema() -> dict:
    global _SCHEMA
    if _SCHEMA is None:
        _SCHEMA = json.loads(_load_schema_text())
    return _SCHEMA


def _is_int(x):
    return (isinstance(x, int) and not isinstance(x, bool)) or (isinstance(x, float) and x.is_integer())


def _is_num(x):
    return isinstance(x, (int, float)) and not isinstance(x, bool)


_TYPES = {
    "object": lambda x: isinstance(x, dict),
    "array": lambda x: isinstance(x, list),
    "string": lambda x: isinstance(x, str),
    "boolean": lambda x: isinstance(x, bool),
    "integer": _is_int,
    "number": _is_num,
}


def _resolve(ref: str, root: dict) -> dict:
    node = root
    for part in ref.lstrip("#/").split("/"):
        node = node[part]
    return node


def _join(path: str, key) -> str:
    if isinstance(key, int):
        return f"{path}[{key}]"
    return f"{path}.{key}" if path else str(key)


def _check(inst, sch, path, errs, root) -> None:
    if "$ref" in sch:
        _check(inst, _resolve(sch["$ref"], root), path, errs, root)
        return
    where = path or "<root>"
    if "oneOf" in sch:
        branches = []
        for sub in sch["oneOf"]:
            e: list = []
            _check(inst, sub, path, e, root)
            branches.append(e)
        ok = sum(1 for e in branches if not e)
        if ok != 1:
            best = min(branches, key=len)
            errs.extend(best if ok == 0 else [f"{where}: matches more than one alternative"])
        return
    t = sch.get("type")
    if t is not None and not _TYPES[t](inst):
        errs.append(f"{where}: expected {t}, got {type(inst).__name__}")
        return
    if "const" in sch and inst != sch["const"]:
        errs.append(f"{where}: must equal {sch['const']!r}, got {inst!r}")
    if "enum" in sch and inst not in sch["enum"]:
        errs.append(f"{where}: must be one of {sch['enum']}, got {inst!r}")
    if _is_num(inst):
        if "minimum" in sch and inst < sch["minimum"]:
            errs.append(f"{where}: {inst} is below minimum {sch['minimum']}")
        if "maximum" in sch and inst > sch["maximum"]:
            errs.append(f"{where}: {inst} is above maximum {sch['maximum']}")
        if "exclusiveMinimum" in sch and inst <= sch["exclusiveMinimum"]:
            errs.append(f"{where}: {inst} must be greater than {sch['exclusiveMinimum']}")
    if isinstance(inst, str):
        if "minLength" in sch and len(inst) < sch["minLength"]:
            errs.append(f"{where}: shorter than minLength {sch['minLength']}")
        if "maxLength" in sch and len(inst) > sch["maxLength"]:
            errs.append(f"{where}: longer than maxLength {sch['maxLength']}")
        if "pattern" in sch and not re.search(sch["pattern"], inst):
            errs.append(f"{where}: {inst!r} does not match pattern {sch['pattern']}")
    if isinstance(inst, list):
        if "minItems" in sch and len(inst) < sch["minItems"]:
            errs.append(f"{where}: needs at least {sch['minItems']} item(s)")
        if "maxItems" in sch and len(inst) > sch["maxItems"]:
            errs.append(f"{where}: allows at most {sch['maxItems']} item(s)")
        if sch.get("uniqueItems") and len({json.dumps(x, sort_keys=True) for x in inst}) != len(inst):
            errs.append(f"{where}: items must be unique")
        if "items" in sch:
            for i, item in enumerate(inst):
                _check(item, sch["items"], _join(path, i), errs, root)
    if isinstance(inst, dict):
        for req in sch.get("required", []):
            if req not in inst:
                errs.append(f"{where}: missing required field '{req}'")
        props = sch.get("properties", {})
        for key, val in inst.items():
            if key in props:
                _check(val, props[key], _join(path, key), errs, root)
            else:
                ap = sch.get("additionalProperties", True)
                if ap is False:
                    errs.append(f"{_join(path, key)}: unknown field (additionalProperties is false)")
                elif isinstance(ap, dict):
                    _check(val, ap, _join(path, key), errs, root)


def validate_schema(instance, schema=None) -> list:
    """Return a list of 'path: message' strings (empty when valid)."""
    schema = schema or config_schema()
    errs: list = []
    _check(instance, schema, "", errs, schema)
    return errs
