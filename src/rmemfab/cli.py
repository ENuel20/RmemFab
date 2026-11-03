"""rmemfab command line: validate, run, summary, sweep, compare, export."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from . import __version__
from .config.scenario import ScenarioError, build_scenario, load_raw, validate
from .core.engine import Engine
from .sweep.compare import ComparisonRefused, compare_runs, text_report
from .sweep.export import ExportError, export
from .sweep.runner import SweepError, run_sweep, run_sweep_scenario
from .telemetry.summary import canonical, human
from .trace.replay import ReplayDivergence, ReplayEngine
from .trace.validate import TraceError, load_trace


def _cmd_validate(a) -> int:
    try:
        raw = load_raw(a.scenario)
    except (ScenarioError, OSError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    errors, warnings, assumed = validate(raw, a.require_provenance,
                                         base_dir=Path(a.scenario).parent)
    for e in errors:
        print(f"error: {e}", file=sys.stderr)
    for w in warnings:
        print(f"warning: {w}", file=sys.stderr)
    if errors:
        return 1
    from .config.scenario import scenario_hash
    print(f"OK {raw['name']}  hash={scenario_hash(raw)}  assumed-parameters={len(assumed)}")
    return 0


def _cmd_run(a) -> int:
    try:
        raw = load_raw(a.scenario)
        sc = build_scenario(raw, seed=a.seed, policy=a.policy, strict_policy=a.strict_policy,
                            base_dir=Path(a.scenario).parent)
    except (ScenarioError, OSError) as exc:
        for e in getattr(exc, "errors", [str(exc)]):
            print(f"error: {e}", file=sys.stderr)
        return 1
    for w in sc.warnings:
        print(f"warning: {w}", file=sys.stderr)
    out = Path(a.out or sc.output.get("path") or f"runs/{sc.name}")
    engine = ReplayEngine(sc, sc.trace, out, event_log=not a.no_events) \
        if sc.workload_type == "trace" else Engine(sc, out, event_log=not a.no_events)
    try:
        summary, manifest = engine.run()
    except ReplayDivergence as exc:
        print(f"error: replay diverged: {exc}", file=sys.stderr)
        return 1
    if not a.quiet:
        print(human(summary))
    print(f"run bundle: {out}")
    return 0


def _cmd_trace_validate(a) -> int:
    try:
        vt = load_trace(a.trace, sort=a.sort, round_bytes=a.round_bytes,
                        time_scale=a.time_scale, page_size=a.page_size, node=a.node)
    except TraceError as exc:
        for e in exc.errors:
            print(f"error: {e}", file=sys.stderr)
        return 1
    r = vt.report
    print(f"OK {a.trace}  sha256={vt.sha256[:16]}  ops={r['stats']['ops']}  "
          f"pages={r['stats']['pages']}  requests={r['stats']['requests']}  "
          f"unit={vt.unit_bytes}  span=[{r['stats']['ts_min']},{r['stats']['ts_max']}]")
    for w in r["warnings"]:
        print(f"warning: {w}")
    n = r["normalization"]
    print(f"normalization: sort={n['sort_applied']} time_scale={n['time_scale']} "
          f"round_bytes={n['round_bytes']}")
    return 0


def _cmd_summary(a) -> int:
    p = Path(a.run) / "summary.json"
    if not p.is_file():
        print(f"error: {p} not found", file=sys.stderr)
        return 1
    s = json.loads(p.read_text(encoding="utf-8"))
    print(canonical(s) if a.canonical else human(s))
    return 0


def _cmd_sweep(a) -> int:
    try:
        if a.set or a.seeds is not None or a.same_seed:
            seeds = ([int(s) for s in a.seeds.split(",")] if a.seeds is not None else None)
            index = run_sweep_scenario(a.spec, a.set, a.out, seeds=seeds,
                                       same_seed=a.same_seed, workers=a.workers or 1,
                                       no_events=a.no_events)
        else:
            index = run_sweep(a.spec, a.out, workers=a.workers)
    except (SweepError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    done = sum(1 for c in index["combos"] if c["status"] == "completed")
    print(f"sweep: {done}/{len(index['combos'])} completed -> {a.out}/sweep.json")
    for c in index["combos"]:
        if c["status"] != "completed":
            print(f"  combo {c['combo']:04d} {c['status']}: {c['error']}")
    return 0


def _cmd_compare(a) -> int:
    try:
        rep = compare_runs(a.runs, multi_seed=a.multi_seed)
    except ComparisonRefused as exc:
        print(f"refused: {exc}", file=sys.stderr)
        return 2
    if a.format == "json":
        print(json.dumps(rep, indent=2, sort_keys=True))
    else:
        print(text_report(rep), end="")
    return 0


def _cmd_export(a) -> int:
    try:
        written = export(a.src, a.out, fmt=a.format)
    except ExportError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    for p in written:
        print(f"wrote {p}")
    return 0


def _cmd_serve(a) -> int:
    try:
        import uvicorn
    except ImportError:
        print("error: rmemfab serve needs the api extra "
              "(pip install 'rmemfab[api]')", file=sys.stderr)
        return 1
    from .api import create_app
    app = create_app(runs_dir=a.runs_dir, traces_dir=a.traces_dir,
                     static_dir=a.static_dir)
    print(f"serving RmemFab API on http://{a.host}:{a.port} "
          f"(runs={a.runs_dir} traces={a.traces_dir})")
    if a.static_dir and (Path(a.static_dir) / "index.html").is_file():
        print(f"serving RmemFab dashboard on http://{a.host}:{a.port}/ "
              f"(build at {a.static_dir})")
    else:
        print("dashboard build not found: run `make dashboard-dist` or use "
              "the vite dev server (cd dashboard && npm run dev)")
    if a.open:
        import webbrowser
        webbrowser.open(f"http://{a.host}:{a.port}/docs")
    uvicorn.run(app, host=a.host, port=a.port)
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="rmemfab", description="Remote Memory Fabric Simulator")
    ap.add_argument("--version", action="version", version=f"rmemfab {__version__}")
    sub = ap.add_subparsers(dest="cmd", required=True)
    v = sub.add_parser("validate", help="validate a scenario without running it")
    v.add_argument("scenario")
    v.add_argument("--require-provenance", action="store_true")
    v.set_defaults(fn=_cmd_validate)
    r = sub.add_parser("run", help="run a scenario and write a run bundle")
    r.add_argument("scenario")
    r.add_argument("--seed", type=int)
    r.add_argument("--out")
    r.add_argument("--policy", help="override policy.name (params are cleared)")
    r.add_argument("--strict-policy", action="store_true", help="fail instead of falling back for later-phase policies")
    r.add_argument("--no-events", action="store_true", help="skip events.jsonl (summary-only run)")
    r.add_argument("--quiet", action="store_true")
    r.set_defaults(fn=_cmd_run)
    s = sub.add_parser("summary", help="print a run summary")
    s.add_argument("run")
    s.add_argument("--canonical", action="store_true", help="byte-stable JSON for diffing")
    s.set_defaults(fn=_cmd_summary)
    t = sub.add_parser("trace-validate", help="validate a trace file for replay")
    t.add_argument("trace")
    t.add_argument("--page-size", type=int, default=None)
    t.add_argument("--sort", dest="sort", action="store_true", default=True)
    t.add_argument("--no-sort", dest="sort", action="store_false")
    t.add_argument("--round-bytes", action="store_true", default=False)
    t.add_argument("--time-scale", type=float, default=1.0)
    t.add_argument("--node", default=None)
    t.set_defaults(fn=_cmd_trace_validate)
    w = sub.add_parser("sweep", help="run a parameter sweep (grid x seeds)")
    w.add_argument("spec", help="sweep spec JSON, or a scenario with --set/--seeds")
    w.add_argument("--out", required=True, help="sweep output directory")
    w.add_argument("--workers", type=int, default=None, help="parallel workers (default: spec, else 1)")
    w.add_argument("--set", action="append", default=[],
                   help="scenario mode: path=v1,v2 (repeatable, brackets ok: links[0].latency_ns)")
    w.add_argument("--seeds", default=None, help="scenario mode: comma-separated seeds")
    w.add_argument("--same-seed", action="store_true", help="scenario mode: use the scenario seed")
    w.add_argument("--no-events", action="store_true", help="scenario mode: skip events.jsonl")
    w.set_defaults(fn=_cmd_sweep)
    c = sub.add_parser("compare", help="compare run bundles (refuses unless controlled)")
    c.add_argument("runs", nargs="+", help="run bundle directories")
    c.add_argument("--multi-seed", action="store_true", help="group by policy across seeds with 95% CIs")
    c.add_argument("--format", choices=["text", "json"], default="text")
    c.set_defaults(fn=_cmd_compare)
    e = sub.add_parser("export", help="export a bundle or sweep to CSV/JSON")
    e.add_argument("src", help="run bundle or sweep directory")
    e.add_argument("--out", required=True, help="export output directory")
    e.add_argument("--format", choices=["csv", "json"], default="csv")
    e.set_defaults(fn=_cmd_export)
    s = sub.add_parser("serve", help="serve the Run API on localhost")
    s.add_argument("--host", default="127.0.0.1")
    s.add_argument("--port", type=int, default=8000)
    s.add_argument("--runs-dir", default="runs")
    s.add_argument("--traces-dir", default="traces/uploads")
    s.add_argument("--static-dir", default="dashboard/dist",
                   help="built dashboard to serve at / (empty disables)")
    s.add_argument("--open", action="store_true",
                   help="open the API docs in a browser")
    s.set_defaults(fn=_cmd_serve)
    a = ap.parse_args(argv)
    return a.fn(a)


if __name__ == "__main__":
    raise SystemExit(main())
