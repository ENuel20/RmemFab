"""CSV/JSON export for run bundles and sweep indexes.

``export <bundle>`` flattens one run's key metrics to a single CSV row (plus
an optional series.csv from the bundle's series.jsonl). ``export <sweep>``
writes one row per completed combo: grid params first, then the shared
metric columns. JSON export copies the underlying summary/sweep documents
unchanged — export never recomputes, so exported numbers always match the
bundle on disk.
"""
from __future__ import annotations

import csv
import json
import shutil
from pathlib import Path

from .metrics import COLUMNS, extract


class ExportError(Exception):
    pass


def _csv_value(v):
    if v is None:
        return ""
    if isinstance(v, float):
        return repr(v)
    return str(v)


def export_bundle(bundle, out_dir, *, fmt="csv", series=True) -> list:
    d = Path(bundle)
    sfile = d / "summary.json"
    if not sfile.is_file():
        raise ExportError(f"{d} is not a run bundle (no summary.json)")
    summary = json.loads(sfile.read_text(encoding="utf-8"))
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    written = []
    if fmt == "json":
        shutil.copy(sfile, out / "summary.json")
        written.append(out / "summary.json")
    elif fmt == "csv":
        row = {"combo": "", "bundle": d.name, **extract(summary)}
        with open(out / "summary.csv", "w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=COLUMNS, extrasaction="ignore")
            w.writeheader()
            w.writerow({k: _csv_value(row.get(k)) for k in COLUMNS})
        written.append(out / "summary.csv")
    else:
        raise ExportError(f"unknown format '{fmt}' (csv or json)")
    if series and (d / "series.jsonl").is_file():
        rows = [json.loads(line) for line in
                (d / "series.jsonl").read_text(encoding="utf-8").splitlines() if line.strip()]
        if rows:
            cols = sorted({k for r in rows for k in r})
            with open(out / "series.csv", "w", newline="", encoding="utf-8") as f:
                w = csv.DictWriter(f, fieldnames=cols, extrasaction="ignore")
                w.writeheader()
                w.writerows({k: _csv_value(r.get(k)) for k in cols} for r in rows)
            written.append(out / "series.csv")
    return written


def export_sweep(sweep_dir, out_dir, *, fmt="csv") -> list:
    d = Path(sweep_dir)
    sfile = d / "sweep.json"
    if not sfile.is_file():
        raise ExportError(f"{d} is not a sweep directory (no sweep.json)")
    index = json.loads(sfile.read_text(encoding="utf-8"))
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    if fmt == "json":
        shutil.copy(sfile, out / "sweep.json")
        return [out / "sweep.json"]
    if fmt != "csv":
        raise ExportError(f"unknown format '{fmt}' (csv or json)")
    combos = index.get("combos", [])
    params = sorted({k for c in combos for k in c.get("params", {})})
    cols = ["combo", "status"] + [f"param:{p}" for p in params] + COLUMNS[1:]
    with open(out / "sweep.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=cols, extrasaction="ignore")
        w.writeheader()
        for c in combos:
            row = {"combo": c["combo"], "status": c["status"]}
            for p in params:
                row[f"param:{p}"] = _csv_value(c.get("params", {}).get(p))
            m = c.get("metrics") or {}
            for k in COLUMNS[1:]:
                if k == "bundle":
                    row[k] = c.get("bundle") or ""
                else:
                    row[k] = _csv_value(m.get(k))
            w.writerow(row)
    return [out / "sweep.csv"]


def export(src, out_dir, *, fmt="csv") -> list:
    src = Path(src)
    if (src / "sweep.json").is_file():
        return export_sweep(src, out_dir, fmt=fmt)
    return export_bundle(src, out_dir, fmt=fmt)
