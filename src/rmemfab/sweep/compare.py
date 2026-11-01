"""Guarded run comparison: refuse unless controlled, then tabulate.

A comparison is controlled when every bundle's scenario is identical except
the ``policy`` block (and ``seed`` across multi-seed groups). The guard names
the first differing field instead of printing a misleading table::

    Refused: scenarios differ at nodes.0.local_memory.capacity_bytes
             (1048576 vs 2097152). Compare runs from one sweep to hold
             the workload and hardware fixed.

Multi-seed groups report mean +/- 95% CI per metric (Student-t critical
values, hardcoded so results need no scipy and are byte-stable). n=1 groups
report the single value with ci95 None — an interval from one sample would
be fiction.
"""
from __future__ import annotations

import copy
import json
import math
from pathlib import Path

from .metrics import extract

#: Compared metrics: (key, higher_is_better or None when direction is workload-defined).
METRICS = [
    ("read_mean_ns", False), ("read_p50_ns", False), ("read_p95_ns", False),
    ("read_p99_ns", False), ("local_hit_ratio", True), ("remote_hit_ratio", None),
    ("miss_ratio", False), ("remote_read_bytes", False), ("migration_bytes", None),
    ("prefetch_accuracy", True), ("prefetch_issued", None), ("wasted_prefetch_bytes", False),
    ("stall_ns", False), ("throughput_per_s", True),
]

#: Two-sided t_{0.975,df} for df 1..30, then normal 1.96.
_T95 = {1: 12.706, 2: 4.303, 3: 3.182, 4: 2.776, 5: 2.571, 6: 2.447, 7: 2.365,
        8: 2.306, 9: 2.262, 10: 2.228, 11: 2.201, 12: 2.179, 13: 2.160, 14: 2.145,
        15: 2.131, 16: 2.120, 17: 2.110, 18: 2.101, 19: 2.093, 20: 2.086, 21: 2.080,
        22: 2.074, 23: 2.069, 24: 2.064, 25: 2.060, 26: 2.056, 27: 2.052, 28: 2.048,
        29: 2.045, 30: 2.042}


class ComparisonRefused(Exception):
    pass


def _strip_controlled(scenario: dict) -> dict:
    c = copy.deepcopy(scenario)
    c.pop("policy", None)
    c.pop("seed", None)
    c.pop("name", None)
    return c


def _first_diff(a, b, path=""):
    if type(a) is not type(b):
        return path or "<root>", a, b
    if isinstance(a, dict):
        for k in sorted(set(a) | set(b)):
            if k not in a:
                return f"{path}.{k}" if path else k, "<missing>", b[k]
            if k not in b:
                return f"{path}.{k}" if path else k, a[k], "<missing>"
            d = _first_diff(a[k], b[k], f"{path}.{k}" if path else k)
            if d:
                return d
        return None
    if isinstance(a, list):
        if len(a) != len(b):
            return path, f"<list len {len(a)}>", f"<list len {len(b)}>"
        for i, (x, y) in enumerate(zip(a, b)):
            d = _first_diff(x, y, f"{path}.{i}")
            if d:
                return d
        return None
    return None if a == b else (path, a, b)


def check_controlled(scenarios: list, manifests: list, *, same_seed=True) -> list:
    """Raise ComparisonRefused naming the first uncontrolled difference.
    Returns the distinct seeds (for the report)."""
    seeds = [s.get("seed") for s in scenarios]
    if same_seed and len(set(seeds)) > 1:
        raise ComparisonRefused(
            f"seeds differ {sorted(set(seeds))}; same-seed comparison needs one seed "
            "(pass --multi-seed to group by policy across seeds)")
    versions = {m.get("rmemfab_version") for m in manifests}
    if len(versions) > 1:
        raise ComparisonRefused(
            f"rmemfab versions differ {sorted(versions)}; rerun all bundles with one build")
    base = _strip_controlled(scenarios[0])
    for other in scenarios[1:]:
        d = _first_diff(base, _strip_controlled(other))
        if d:
            path, a, b = d
            raise ComparisonRefused(
                f"scenarios differ at {path} ({a!r} vs {b!r}); hold workload and "
                "hardware fixed (compare runs from one sweep)")
    return sorted(set(seeds))


def _stats(vals: list) -> dict:
    vals = [v for v in vals if v is not None]
    n = len(vals)
    if n == 0:
        return {"n": 0, "mean": None, "stdev": None, "ci95": None, "values": []}
    mean = sum(vals) / n
    if n == 1:
        return {"n": 1, "mean": mean, "stdev": 0.0, "ci95": None, "values": vals}
    var = sum((v - mean) ** 2 for v in vals) / (n - 1)
    sd = math.sqrt(var)
    t = _T95.get(n - 1, 1.96)
    return {"n": n, "mean": mean, "stdev": sd, "ci95": t * sd / math.sqrt(n),
            "values": vals}


def load_bundle(path) -> tuple:
    d = Path(path)
    try:
        scenario = json.loads((d / "scenario.json").read_text(encoding="utf-8"))
        summary = json.loads((d / "summary.json").read_text(encoding="utf-8"))
        manifest = json.loads((d / "manifest.json").read_text(encoding="utf-8"))
    except OSError as exc:
        raise ComparisonRefused(f"bundle {d} is missing run files: {exc}")
    except json.JSONDecodeError as exc:
        raise ComparisonRefused(f"bundle {d} has invalid JSON: {exc}")
    return scenario, summary, manifest


def compare_runs(paths, *, multi_seed=False) -> dict:
    """Compare run bundles. multi_seed groups by policy.effective across seeds."""
    if len(paths) < 2:
        raise ComparisonRefused("need at least two runs to compare")
    loaded = [(str(p),) + load_bundle(p) for p in paths]
    check_controlled([s for _, s, _, _ in loaded], [m for _, _, _, m in loaded],
                     same_seed=not multi_seed)
    rows = [{"bundle": p, "scenario": s, "metrics": extract(m)} for p, s, m, _ in loaded]
    policies = sorted({r["metrics"]["policy"] for r in rows})
    seeds = sorted({r["metrics"]["seed"] for r in rows})
    if multi_seed:
        groups = {}
        for pol in policies:
            members = [r for r in rows if r["metrics"]["policy"] == pol]
            groups[pol] = {
                "seeds": sorted(r["metrics"]["seed"] for r in members),
                "bundles": [r["bundle"] for r in members],
                "metrics": {k: _stats([r["metrics"][k] for r in members]) for k, _ in METRICS},
            }
        return {"mode": "multi_seed", "policies": policies, "seeds": seeds,
                "groups": groups,
                "metric_direction": {k: d for k, d in METRICS}}
    table = [{"bundle": r["bundle"], "policy": r["metrics"]["policy"],
              "seed": r["metrics"]["seed"],
              **{k: r["metrics"][k] for k, _ in METRICS}} for r in rows]
    return {"mode": "same_seed", "policies": policies, "seed": seeds[0] if len(seeds) == 1 else seeds,
            "verdict": "directional: single seed, no spread estimate (rerun with --multi-seed)",
            "runs": table, "metric_direction": {k: d for k, d in METRICS}}


def _fmt(v):
    if v is None:
        return "--"
    if isinstance(v, float):
        return f"{v:,.4f}" if abs(v) < 1000 else f"{v:,.1f}"
    return str(v)


def text_report(rep: dict) -> str:
    lines = []
    if rep["mode"] == "same_seed":
        lines.append(f"same-seed comparison (seed {rep['seed']}) -- DIRECTIONAL, single seed")
        header = ["metric"] + [f"{r['policy']}" for r in rep["runs"]]
        lines.append("  ".join(["%-22s" % header[0]] + ["%12s" % h for h in header[1:]]))
        for k, _ in METRICS:
            lines.append("  ".join(["%-22s" % k] + ["%12s" % _fmt(r[k]) for r in rep["runs"]]))
    else:
        lines.append(f"multi-seed comparison (seeds {rep['seeds']})")
        for pol in rep["policies"]:
            g = rep["groups"][pol]
            lines.append(f"== {pol} (n={g['metrics']['read_p50_ns']['n']}) ==")
            for k, _ in METRICS:
                s = g["metrics"][k]
                ci = "" if s["ci95"] is None else f" +/- {_fmt(s['ci95'])}"
                lines.append(f"  {k:<20} {_fmt(s['mean'])}{ci}")
    return "\n".join(lines) + "\n"
