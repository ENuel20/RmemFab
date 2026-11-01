"""Parameter sweep runner: cartesian grid x seeds, parallel workers.

A sweep spec names a base scenario plus a grid of dotted paths to vary::

    {"name": "policy-x-seed", "base": "examples/phase2-replay-opt.json",
     "grid": {"policy.name": ["swap_remote", "hot_cold"]},
     "seeds": [7, 8, 9], "workers": 4, "no_events": true}

Determinism: combos are enumerated in sorted-grid-key order (outermost key
varies slowest), bundles land in ``combos/<i>/``, and ``sweep.json`` is
canonical JSON — the same spec always yields the same index bytes. Workers
only affect wall time. A variant that fails validation (or diverges in
replay) is recorded with status failed/skipped and its first error, never
silently dropped.
"""
from __future__ import annotations

import copy
import hashlib
import itertools
import json
import os
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

from .. import __version__
from ..config.scenario import (ScenarioError, build_scenario, canonical_json, load_raw)
from ..core.engine import Engine
from ..trace.replay import ReplayDivergence, ReplayEngine
from .metrics import extract


class SweepError(Exception):
    pass


def _segments(dotted: str) -> list:
    """Split ``a.links[0].b`` into ('key', 'links'), ('idx', 0), ('key', 'b')."""
    segs = []
    for part in dotted.split("."):
        while "[" in part:
            name, rest = part.split("[", 1)
            if name:
                segs.append(("key", name))
            idx, part = rest.split("]", 1)
            segs.append(("idx", int(idx)))
            part = part.lstrip(".")
            if part:
                for extra in part.split("."):
                    segs.append(("key", extra))
                part = ""
        if part:
            segs.append(("key", part))
    return segs


def set_path(raw: dict, dotted: str, value):
    """Set ``a.b.0.c`` or ``a.b[0].c`` inside nested dicts/lists."""
    cur, segs = raw, _segments(dotted)
    if not segs:
        raise SweepError(f"empty grid path")
    for kind, seg in segs[:-1]:
        cur = cur[seg] if kind == "idx" else (
            cur[int(seg)] if isinstance(cur, list) else cur.setdefault(seg, {}))
    kind, last = segs[-1]
    if kind == "idx" or isinstance(cur, list):
        cur[int(last)] = value
    else:
        cur[last] = value


def parse_set(expr: str) -> tuple:
    """Parse ``path=v1,v2`` into (path, [values]); values are JSON-decoded
    with a plain-string fallback (180 -> 180, swap_remote -> 'swap_remote')."""
    if "=" not in expr:
        raise SweepError(f"--set needs path=v1,v2, got '{expr}'")
    path, raw = expr.split("=", 1)
    path = path.strip()
    if not path:
        raise SweepError(f"--set needs a path, got '{expr}'")
    vals = []
    for v in raw.split(","):
        v = v.strip()
        try:
            vals.append(json.loads(v))
        except (json.JSONDecodeError, ValueError):
            vals.append(v)
    if not vals:
        raise SweepError(f"--set '{path}' needs at least one value")
    return path, vals


def _order_grid_keys(grid: dict) -> list:
    # policy.name first so a policy switch clears stale params before
    # policy.params.* paths of the same combo are applied.
    return sorted(grid, key=lambda k: (k != "policy.name", k))


def enumerate_combos(grid: dict, seeds: list) -> list:
    """Cartesian combos in deterministic order. Each combo is a list of
    (dotted_path, value) plus ('seed', s)."""
    keys = _order_grid_keys(grid or {})
    combos = []
    for vals in itertools.product(*(grid[k] for k in keys), seeds):
        combo = list(zip(keys, vals[:-1]))
        if any(k == "policy.name" for k, _ in combo):
            combo = [c for c in combo if not (c[0] == "policy" and isinstance(c[1], dict))]
        combos.append(combo + [("seed", vals[-1])])
    return combos


def apply_combo(raw: dict, combo: list) -> dict:
    out = copy.deepcopy(raw)
    for path, value in combo:
        if path == "seed":
            out["seed"] = value
        elif path == "policy.name":
            out["policy"] = {"name": value}
        else:
            set_path(out, path, value)
    return out


def _run_one(args):
    """Worker body: build + run one combo. Returns a JSON-safe record."""
    idx, variant, base_dir, combo_dir, no_events = args
    try:
        sc = build_scenario(variant, base_dir=base_dir)
    except (ScenarioError, OSError) as exc:
        errs = getattr(exc, "errors", [str(exc)])
        return {"combo": idx, "status": "failed", "error": str(errs[0]),
                "metrics": None, "bundle": None}
    engine = ReplayEngine(sc, sc.trace, combo_dir, event_log=not no_events) \
        if sc.workload_type == "trace" else Engine(sc, combo_dir, event_log=not no_events)
    try:
        summary, _ = engine.run()
    except ReplayDivergence as exc:
        return {"combo": idx, "status": "diverged", "error": str(exc),
                "metrics": None, "bundle": None}
    return {"combo": idx, "status": "completed", "error": None,
            "metrics": extract(summary), "bundle": os.path.basename(combo_dir)}


def _check_spec(spec: dict, spec_path: Path) -> tuple:
    if not isinstance(spec, dict):
        raise SweepError("sweep spec must be a JSON object")
    for key in ("base", "grid", "seeds"):
        if key not in spec:
            raise SweepError(f"sweep spec is missing '{key}'")
    base = Path(spec["base"])
    if not base.is_absolute():
        base = spec_path.parent / base
    if not base.is_file():
        raise SweepError(f"base scenario not found: {base}")
    grid = spec["grid"]
    if not isinstance(grid, dict) or not grid:
        raise SweepError("sweep spec 'grid' must be a non-empty object of path -> values")
    for k, v in grid.items():
        if not isinstance(v, list) or not v:
            raise SweepError(f"grid '{k}' must be a non-empty list of values")
    seeds = spec["seeds"]
    if not isinstance(seeds, list) or not seeds or any(not isinstance(s, int) for s in seeds):
        raise SweepError("sweep spec 'seeds' must be a non-empty list of ints")
    workers = int(spec.get("workers", 1))
    if workers < 1:
        raise SweepError("sweep spec 'workers' must be >= 1")
    return base, grid, seeds, workers


def _execute(*, name, raw, base_dir, base_rel, grid, seeds, out_dir, workers,
             no_events, fingerprint) -> dict:
    out_dir.mkdir(parents=True, exist_ok=True)
    combos = enumerate_combos(grid, seeds)
    combo_dirs = [out_dir / "combos" / f"{i:04d}" for i in range(len(combos))]
    variants, params = [], []
    for c in combos:
        try:
            variants.append(apply_combo(raw, c))
        except (KeyError, IndexError, ValueError, TypeError) as exc:
            variants.append(exc)
        params.append({p: v for p, v in c})
    results = []
    todo = [(i, variants[i], base_dir, str(combo_dirs[i]), no_events)
            for i in range(len(combos)) if not isinstance(variants[i], Exception)]
    for i in range(len(combos)):
        if isinstance(variants[i], Exception):
            results.append({"combo": i, "status": "failed",
                            "error": f"grid path does not apply: {variants[i]}",
                            "metrics": None, "bundle": None})
    if todo:
        if workers == 1:
            results.extend(_run_one(a) for a in todo)
        else:
            with ProcessPoolExecutor(max_workers=workers) as ex:
                results.extend(ex.map(_run_one, todo))
    results.sort(key=lambda r: r["combo"])
    index = {
        "schema": "rmemfab.sweep/0.1", "rmemfab_version": __version__, "name": name,
        "spec_hash": hashlib.sha256(
            json.dumps(fingerprint, sort_keys=True).encode()).hexdigest(),
        "base": base_rel, "base_dir": os.path.relpath(Path(base_dir), Path.cwd()),
        "grid": grid, "seeds": seeds, "workers": workers,
        "combos": [
            {"combo": i, "params": params[i], "bundle":
             (f"combos/{r['bundle']}" if r["bundle"] else None),
             "status": r["status"], "error": r["error"], "metrics": r["metrics"]}
            for i, r in enumerate(results)],
    }
    (out_dir / "sweep.json").write_text(canonical_json(index) + "\n", encoding="utf-8")
    return index


def run_sweep(spec_path, out_dir, *, workers=None) -> dict:
    spec_path, out_dir = Path(spec_path), Path(out_dir)
    try:
        spec = json.loads(spec_path.read_text(encoding="utf-8"))
    except OSError as exc:
        raise SweepError(str(exc))
    except json.JSONDecodeError as exc:
        raise SweepError(f"invalid JSON: {exc}")
    base, grid, seeds, spec_workers = _check_spec(spec, spec_path)
    workers = spec_workers if workers is None else workers
    if workers < 1:
        raise SweepError("--workers must be >= 1")
    return _execute(name=spec.get("name", spec_path.stem), raw=load_raw(str(base)),
                    base_dir=str(base.parent),
                    base_rel=os.path.relpath(base, spec_path.parent),
                    grid=grid, seeds=seeds, out_dir=out_dir, workers=workers,
                    no_events=bool(spec.get("no_events", False)), fingerprint=spec)


def run_sweep_scenario(scenario_path, sets, out_dir, *, seeds=None, same_seed=False,
                       workers=1, no_events=False) -> dict:
    """Scenario mode: sweep SCENARIO --set path=v1,v2 [--seeds 7,8]."""
    scenario_path, out_dir = Path(scenario_path), Path(out_dir)
    if workers < 1:
        raise SweepError("--workers must be >= 1")
    try:
        raw = load_raw(str(scenario_path))
    except (ScenarioError, OSError) as exc:
        raise SweepError(str(exc))
    grid = {}
    for expr in sets or []:
        path, vals = parse_set(expr)
        grid[path] = vals
    if seeds is None or same_seed:
        seeds = [int(raw.get("seed", 0))]
    return _execute(name=f"{scenario_path.stem}-sweep", raw=raw,
                    base_dir=str(scenario_path.parent),
                    base_rel=os.path.relpath(scenario_path, Path.cwd()),
                    grid=grid, seeds=list(seeds), out_dir=out_dir, workers=workers,
                    no_events=no_events,
                    fingerprint={"base": str(scenario_path), "grid": grid, "seeds": seeds})
