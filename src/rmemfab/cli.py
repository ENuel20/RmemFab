"""rmemfab command line: validate, run, summary."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from . import __version__
from .config.scenario import ScenarioError, build_scenario, load_raw, scenario_hash, validate
from .core.runner import make_engine
import pickle

from .telemetry.summary import canonical, human
from .workloads.generators import Params, generate_ops
from .workloads.snapshot import convert_snapshot, load_snapshot
from .workloads.trace import TraceError, load_trace, normalize_trace, write_trace


def _cmd_validate(a) -> int:
    try:
        raw = load_raw(a.scenario)
    except (ScenarioError, OSError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    errors, warnings, assumed = validate(raw, a.require_provenance, base_dir=Path(a.scenario).resolve().parent)
    for e in errors:
        print(f"error: {e}", file=sys.stderr)
    for w in warnings:
        print(f"warning: {w}", file=sys.stderr)
    if errors:
        return 1
    print(f"OK {raw['name']}  hash={scenario_hash(raw)}  assumed-parameters={len(assumed)}")
    return 0


def _cmd_run(a) -> int:
    try:
        path = Path(a.scenario)
        base = path.resolve().parent
        if a.workload_type == "trace" or path.suffix == ".jsonl":
            if not a.template:
                print("error: replaying a bare trace needs --scenario TEMPLATE.json (hardware, fabric, policy)",
                      file=sys.stderr)
                return 1
            raw = load_raw(a.template)
            base = Path(a.template).resolve().parent
            raw["workload"] = {"type": "trace", "path": str(path.resolve())}
            raw["name"] = f"replay-{path.stem}"[:120]
            raw.setdefault("output", {})["path"] = f"runs/{raw['name']}"
        else:
            raw = load_raw(path)
        sc = build_scenario(raw, seed=a.seed, policy=a.policy, strict_policy=a.strict_policy, base_dir=base)
        eng = make_engine(sc, Path(a.out or sc.output.get("path") or f"runs/{sc.name}"), event_log=not a.no_events,
                          open_loop=a.open_loop, best_effort=a.trace_best_effort,
                          trace_sort=True if a.trace_sort else None, backpressure=a.backpressure)
    except (ScenarioError, OSError) as exc:
        for e in getattr(exc, "errors", [str(exc)]):
            print(f"error: {e}", file=sys.stderr)
        return 1
    except TraceError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    for w in sc.warnings:
        print(f"warning: {w}", file=sys.stderr)
    summary, manifest = eng.run()
    if manifest.get("label_note"):
        print(f"warning: {manifest['label_note']}", file=sys.stderr)
    if not a.quiet:
        print(human(summary))
    print(f"run bundle: {eng.out_dir}")
    return 0


def _cmd_generate(a) -> int:
    try:
        raw = load_raw(a.scenario)
        sc = build_scenario(raw, seed=a.seed, base_dir=Path(a.scenario).resolve().parent)
        if sc.workload_type == "trace":
            print("error: scenario already uses a trace workload", file=sys.stderr)
            return 1
        params = Params(sc)
        ops = list(generate_ops(sc, params))
    except (ScenarioError, OSError) as exc:
        for e in getattr(exc, "errors", [str(exc)]):
            print(f"error: {e}", file=sys.stderr)
        return 1
    header = {"type": "header", "trace_version": "0.1", "source": "rmemfab-synthetic", "model": sc.model.get("name", ""),
              "clock_unit": "ns", "label": "synthetic", "ts_origin_ns": 0, "page_size_bytes": sc.page_size,
              "generator": {"profile": sc.profile, "scenario_hash": sc.hash, "seed": sc.seed,
                            "defaulted_parameters": params.defaulted, "page_normalization": params.rounded}}
    if not header["model"]:
        del header["model"]
    info = write_trace(a.out, header, ops)
    print(f"wrote {info['records']} records to {a.out}  sha256={info['sha256']}")
    return 0


def _cmd_convert(a) -> int:
    try:
        snap, sha = load_snapshot(a.snapshot)
        header, ops, rep = convert_snapshot(snap, source_sha256=sha, label=a.label, touch_on_alloc=a.touch_on_alloc)
    except (OSError, ValueError, pickle.UnpicklingError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    info = write_trace(a.out, header, ops)
    print(f"wrote {info['records']} records to {a.out}  sha256={info['sha256']}")
    print(json.dumps(rep, sort_keys=True))
    return 0


def _cmd_trace_info(a) -> int:
    try:
        lt = load_trace(a.trace, a.page_size, sort=a.sort, round_bytes=True, best_effort=a.best_effort)
    except (OSError, TraceError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    print(json.dumps(lt.info, indent=2, sort_keys=True))
    if lt.info.get("best_effort_warning"):
        print("warning: " + lt.info["best_effort_warning"], file=sys.stderr)
    return 0


def _cmd_trace_normalize(a) -> int:
    try:
        rep = normalize_trace(a.trace, a.out, label=a.label, page_size=a.page_size, hoist_allocs=a.hoist_allocs)
    except (OSError, TraceError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    print(json.dumps(rep, indent=2, sort_keys=True))
    return 0


def _cmd_summary(a) -> int:
    p = Path(a.run) / "summary.json"
    if not p.is_file():
        print(f"error: {p} not found", file=sys.stderr)
        return 1
    s = json.loads(p.read_text(encoding="utf-8"))
    print(canonical(s) if a.canonical else human(s))
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
    r.add_argument("--open-loop", action="store_true", help="run kv_cache_decode through the op-stream generator")
    r.add_argument("--workload-type", choices=["trace"], help="replay SCENARIO as a bare .jsonl trace (needs --scenario)")
    r.add_argument("--scenario", dest="template", help="template scenario supplying hardware/fabric/policy for a bare trace")
    r.add_argument("--trace-sort", action="store_true", help="stable-sort an out-of-order trace by ts_ns (same as workload.sort=true)")
    r.add_argument("--backpressure", choices=["stall", "report"],
                   help="replay: 'stall' (default) throttles the op stream when a link queue exceeds queue_depth_bytes; 'report' only counts it")
    r.add_argument("--trace-best-effort", action="store_true", help="skip malformed trace lines and report them")
    r.set_defaults(fn=_cmd_run)
    g = sub.add_parser("generate", help="materialize a synthetic workload as a JSONL trace")
    g.add_argument("scenario")
    g.add_argument("--out", required=True)
    g.add_argument("--seed", type=int)
    g.set_defaults(fn=_cmd_generate)
    c = sub.add_parser("convert-snapshot", help="convert a PyTorch CUDA allocator snapshot into a trace")
    c.add_argument("snapshot")
    c.add_argument("-o", "--out", required=True)
    c.add_argument("--label", choices=["measured", "calibrated", "synthetic"], default="measured")
    c.add_argument("--touch-on-alloc", action="store_true", help="synthesize one write per allocation")
    c.set_defaults(fn=_cmd_convert)
    t = sub.add_parser("trace-info", help="validate a trace and print hash, label and page-normalization report")
    t.add_argument("trace")
    t.add_argument("--page-size", type=int, default=2097152)
    t.add_argument("--sort", action="store_true")
    t.add_argument("--best-effort", action="store_true")
    t.set_defaults(fn=_cmd_trace_info)
    n = sub.add_parser("trace-normalize", help="write a spec-conforming copy (stable-sorted, ts>=0, explicit label)")
    n.add_argument("trace")
    n.add_argument("-o", "--out", required=True)
    n.add_argument("--label", choices=["measured", "calibrated", "synthetic"],
                   help="required when the header has no label; never inferred")
    n.add_argument("--page-size", type=int, default=2097152)
    n.add_argument("--hoist-allocs", action="store_true",
                   help="move an alloc that comes after its page's first access up to that access (recorded in the header)")
    n.set_defaults(fn=_cmd_trace_normalize)
    s = sub.add_parser("summary", help="print a run summary")
    s.add_argument("run")
    s.add_argument("--canonical", action="store_true", help="byte-stable JSON for diffing")
    s.set_defaults(fn=_cmd_summary)
    a = ap.parse_args(argv)
    return a.fn(a)


if __name__ == "__main__":
    raise SystemExit(main())
