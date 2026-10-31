"""Pick the right engine for a scenario and run it."""
from __future__ import annotations

from ..config.scenario import resolve_trace_path
from ..workloads.generators import Params, generate_ops
from ..workloads.trace import load_trace
from .engine import Engine
from .replay import ReplayEngine


def make_engine(sc, out_dir=None, *, event_log=True, open_loop=False, best_effort=False, trace_sort=None,
                backpressure=None):
    if sc.workload_type == "trace":
        cfg = sc.trace_cfg
        path = resolve_trace_path(cfg["path"], sc.base_dir)
        lt = load_trace(path, sc.page_size, sort=bool(cfg.get("sort", False)) if trace_sort is None else bool(trace_sort),
                        round_bytes=bool(cfg.get("round_bytes", True)),
                        time_scale=float(cfg.get("time_scale", 1.0)), best_effort=best_effort)
        lt.info["path"] = cfg["path"]
        return ReplayEngine(sc, lt.ops, trace_info=lt.info, label=lt.info["label"],
                            total_records=len(lt.ops), out_dir=out_dir, event_log=event_log,
                            backpressure=backpressure or cfg.get("backpressure", "stall"))
    if sc.profile == "kv_cache_decode" and not open_loop:
        return Engine(sc, out_dir, event_log=event_log)
    params = Params(sc)
    info = {"profile": sc.profile, "mode": "open_loop_ops", "defaulted_parameters": params.defaulted,
            "page_normalization": params.rounded}
    return ReplayEngine(sc, generate_ops(sc, params), generator_info=info, label="synthetic",
                        out_dir=out_dir, event_log=event_log, backpressure=backpressure or "stall")


def run_scenario(sc, out_dir=None, **kw):
    return make_engine(sc, out_dir, **kw).run()
