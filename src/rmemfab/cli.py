"""rmemfab command line: validate, run, summary."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from . import __version__
from .config.scenario import ScenarioError, build_scenario, load_raw, validate
from .core.engine import Engine
from .telemetry.summary import canonical, human


def _cmd_validate(a) -> int:
    try:
        raw = load_raw(a.scenario)
    except (ScenarioError, OSError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    errors, warnings, assumed = validate(raw, a.require_provenance)
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
        sc = build_scenario(raw, seed=a.seed, policy=a.policy, strict_policy=a.strict_policy)
    except (ScenarioError, OSError) as exc:
        for e in getattr(exc, "errors", [str(exc)]):
            print(f"error: {e}", file=sys.stderr)
        return 1
    for w in sc.warnings:
        print(f"warning: {w}", file=sys.stderr)
    out = Path(a.out or sc.output.get("path") or f"runs/{sc.name}")
    summary, manifest = Engine(sc, out, event_log=not a.no_events).run()
    if not a.quiet:
        print(human(summary))
    print(f"run bundle: {out}")
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
    r.set_defaults(fn=_cmd_run)
    s = sub.add_parser("summary", help="print a run summary")
    s.add_argument("run")
    s.add_argument("--canonical", action="store_true", help="byte-stable JSON for diffing")
    s.set_defaults(fn=_cmd_summary)
    a = ap.parse_args(argv)
    return a.fn(a)


if __name__ == "__main__":
    raise SystemExit(main())
