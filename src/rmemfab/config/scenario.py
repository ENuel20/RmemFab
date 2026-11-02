"""Scenario loading, canonical hashing, semantic validation, and normalization."""
from __future__ import annotations

import copy
import hashlib
import json
import math
from dataclasses import dataclass, field
from pathlib import Path

from ..policies import create_policy, known_params
from ..trace.validate import TraceError, load_trace
from ..workloads.geometry import GeometryError, resolve_layer_classes
from .schema import validate_schema

DEFAULT_PAGE_SIZE = 2 * 1024 * 1024
IMPLEMENTED_POLICIES = ("local_only", "swap_remote", "hot_cold", "frequency_aware",
                        "predictive_prefetch")
FALLBACK_POLICY = "swap_remote"
IMPLEMENTED_PROFILES = ("kv_cache_decode",)
DEFAULT_PERCENTILES = (50.0, 95.0, 99.0)


class ScenarioError(Exception):
    def __init__(self, errors):
        self.errors = list(errors)
        super().__init__("; ".join(self.errors))


# ---------------------------------------------------------------- loading ---
def load_raw(path) -> dict:
    p = Path(path)
    text = p.read_text(encoding="utf-8")
    if p.suffix.lower() in (".yaml", ".yml"):
        try:
            import yaml
        except ImportError as exc:  # pragma: no cover
            raise ScenarioError(["YAML scenarios need PyYAML (pip install pyyaml)"]) from exc
        return yaml.safe_load(text)
    try:
        return json.loads(text)
    except json.JSONDecodeError as exc:
        raise ScenarioError([f"{p}: invalid JSON: {exc}"]) from exc


def _normalize_numbers(obj):
    """Canonical numeric form: integral floats become ints (1.0 -> 1)."""
    if isinstance(obj, dict):
        return {k: _normalize_numbers(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_normalize_numbers(v) for v in obj]
    if isinstance(obj, float) and math.isfinite(obj) and obj.is_integer():
        return int(obj)
    return obj


def canonical_json(obj) -> str:
    return json.dumps(_normalize_numbers(obj), sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def scenario_hash(raw: dict) -> str:
    return hashlib.sha256(canonical_json(raw).encode("utf-8")).hexdigest()


# ------------------------------------------------------------- dataclasses ---
@dataclass
class TierSpec:
    capacity_bytes: int
    latency_ns: float
    bandwidth_bytes_per_ns: float
    read_latency_factor: float = 1.0
    write_latency_factor: float = 1.0
    cost_per_byte_second: float = 0.0


@dataclass
class NodeSpec:
    id: str
    local: TierSpec
    compute_tokens_per_second: float | None = None


@dataclass
class PoolSpec:
    id: str
    tier: TierSpec


@dataclass
class LinkSpec:
    id: str
    frm: str
    to: str
    latency_ns: float
    bandwidth_bytes_per_ns: float
    in_flight_bytes: int | None
    queue_depth_bytes: int | None
    bidirectional: bool
    loss_ppm: int | None = None


@dataclass
class SwitchSpec:
    bandwidth_bytes_per_ns: float
    latency_ns: float = 0.0
    id: str = ""


@dataclass
class Route:
    """Static path between two tiers: links in traversal order with the
    declaration-relative direction of each hop, plus intermediate switches."""
    links: list  # [(link_id, "fwd"|"rev")]
    switches: list  # [switch_id...] (intermediate nodes only)

    @property
    def hops(self):
        return len(self.links)


@dataclass
class Scenario:
    raw: dict
    name: str
    hash: str
    seed: int
    duration_ns: int
    warmup_ns: int
    page_size: int
    nodes: list
    pools: dict  # pool id -> PoolSpec
    links: dict  # link id -> LinkSpec
    switches: dict  # switch id -> SwitchSpec
    routes: dict  # (src_tier, dst_tier) -> Route (static shortest path)
    layer_classes: list
    geometry_source: str
    requests: dict
    percentiles: tuple
    sample_interval_ns: int
    policy_requested: str
    policy_effective: str
    policy_params: dict
    fallback_reason: str | None
    cost_model: dict
    output: dict
    workload_type: str = "synthetic"
    trace: object = None
    switch: SwitchSpec | None = None
    warnings: list = field(default_factory=list)
    assumed: list = field(default_factory=list)
    faults: dict = field(default_factory=dict)


# --------------------------------------------------------------- semantics ---
def _build_routes(nodes, pools, links, switches, errors) -> dict:
    """Static shortest-path routes between every pair of tiers (compute
    locals + pools). BFS over directed link adjacency; neighbors visited in
    sorted (endpoint, link) order so ties resolve deterministically. Tiers
    are endpoints, never transit: only switches forward, so no route passes
    through a pool or a peer's local tier (neither is a router, and the
    fabric occupies no server for intermediate tiers).
    Every compute node must reach every pool (hard error naming the pair);
    compute-compute reachability is opportunistic (unreachable peers are
    simply never placement candidates)."""
    adj: dict = {}

    def add(u, v, lid, direction):
        adj.setdefault(u, []).append((v, lid, direction))

    for lid in sorted(links):
        l = links[lid]
        add(l.frm, l.to, lid, "fwd")
        if l.bidirectional:
            add(l.to, l.frm, lid, "rev")
    for u in adj:
        adj[u].sort()
    tiers = [n.id for n in nodes] + sorted(pools)
    switch_ids = set(switches)
    routes: dict = {}
    for src in tiers:
        prev: dict = {src: None}
        queue = [src]
        for u in queue:  # BFS: first visit is shortest (sorted adjacency)
            if u != src and u not in switch_ids:
                continue  # endpoints don't forward
            for v, lid, direction in adj.get(u, []):
                if v not in prev:
                    prev[v] = (u, lid, direction)
                    queue.append(v)
        for dst in tiers:
            if dst == src or dst not in prev:
                continue
            hops, path_nodes = [], [dst]
            u = dst
            while u != src:
                pu, lid, direction = prev[u]
                hops.append((lid, direction))
                path_nodes.append(pu)
                u = pu
            hops.reverse()
            routes[(src, dst)] = Route(
                hops, [x for x in path_nodes if x in switch_ids])
    for cn in nodes:
        for pid in pools:
            if (cn.id, pid) not in routes:
                errors.append(f"fabric: compute node '{cn.id}' cannot reach pool '{pid}' "
                              f"(no directed link path)")
    if not pools:
        for cn in nodes:
            if not any((cn.id, other) in routes for other in [n.id for n in nodes] if other != cn.id):
                errors.append(f"fabric: compute node '{cn.id}' reaches no pool and no peer "
                              f"(remote placement has nowhere to go)")
    return routes


def _build_fabric(raw, errors):
    """Parse nodes/pools/links/switches and static routes. Shared by
    validate() and build_scenario() so both agree on the topology.
    Returns (nodes, pools, links, switches, legacy_switch, routes)."""
    nodes, pools = [], {}
    for n in raw["nodes"]:
        if n["role"] == "compute":
            tps = (n.get("compute") or {}).get("tokens_per_second")
            nodes.append(NodeSpec(n["id"], _tier(n["local_memory"]),
                                  compute_tokens_per_second=float(tps) if tps else None))
        elif "remote_memory" in n:
            pools[n["id"]] = PoolSpec(n["id"], _tier(n["remote_memory"]))
    fab = raw["fabric"]
    if fab.get("switch") is not None and fab.get("switches"):
        errors.append("fabric: 'switch' and 'switches' are exclusive (one single switch or named switches)")
        return nodes, pools, {}, {}, False, {}
    switches: dict = {}
    if fab.get("switch") is not None:
        sw = fab["switch"]
        switches["switch-0"] = SwitchSpec(float(sw["bandwidth_bytes_per_ns"]),
                                          float(sw.get("latency_ns", 0.0)), "switch-0")
        legacy_switch = True
    else:
        for sw in fab.get("switches", []):
            if sw["id"] in switches:
                errors.append(f"fabric.switches: duplicate switch id '{sw['id']}'")
                return nodes, pools, {}, {}, False, {}
            switches[sw["id"]] = SwitchSpec(float(sw["bandwidth_bytes_per_ns"]),
                                            float(sw.get("latency_ns", 0.0)), sw["id"])
        legacy_switch = False
    node_ids = {n.id for n in nodes} | set(pools)
    for sid in switches:
        if sid in node_ids:
            errors.append(f"fabric.switches: id '{sid}' collides with a node id")
            return nodes, pools, {}, {}, False, {}
    endpoints = node_ids | set(switches)
    links: dict = {}
    for i, l in enumerate(fab["links"]):
        if l["id"] in links:
            errors.append(f"fabric.links[{i}]: duplicate link id '{l['id']}'")
            return nodes, pools, {}, {}, False, {}
        for end in (l["from"], l["to"]):
            if end not in endpoints:
                errors.append(f"fabric.links[{i}] ('{l['id']}'): endpoint '{end}' names no node or switch")
                return nodes, pools, {}, {}, False, {}
        if l["from"] == l["to"]:
            errors.append(f"fabric.links[{i}] ('{l['id']}'): self-link is not a path")
            return nodes, pools, {}, {}, False, {}
        links[l["id"]] = LinkSpec(l["id"], l["from"], l["to"], float(l["latency_ns"]),
                                  float(l["bandwidth_bytes_per_ns"]), l.get("in_flight_bytes"),
                                  l.get("queue_depth_bytes"), bool(l.get("bidirectional", True)),
                                  l.get("loss_ppm"))
    routes = _build_routes(nodes, pools, links, switches, errors)
    return nodes, pools, links, switches, legacy_switch, routes


def _tier(d: dict) -> TierSpec:
    return TierSpec(
        capacity_bytes=int(d["capacity_bytes"]),
        latency_ns=float(d["latency_ns"]),
        bandwidth_bytes_per_ns=float(d["bandwidth_bytes_per_ns"]),
        read_latency_factor=float(d.get("read_latency_factor", 1.0)),
        write_latency_factor=float(d.get("write_latency_factor", 1.0)),
        cost_per_byte_second=float(d.get("cost_per_byte_second", 0.0)),
    )


def _provenance_report(raw: dict, require: bool):
    """Return (errors, warnings, assumed) for every tier/compute/link block."""
    errors, warnings, assumed = [], [], []
    blocks = []
    for i, n in enumerate(raw.get("nodes", [])):
        for key in ("local_memory", "remote_memory", "compute"):
            if isinstance(n.get(key), dict):
                blocks.append((f"nodes[{i}].{key}", n[key]))
    for i, l in enumerate(raw.get("fabric", {}).get("links", [])):
        blocks.append((f"fabric.links[{i}]", l))
    for path, blk in blocks:
        prov = blk.get("provenance")
        if not isinstance(prov, dict):
            msg = f"{path}.provenance: missing (declare measured / sourced / assumed)"
            (errors if require else warnings).append(msg)
            continue
        if prov.get("kind") == "assumed":
            assumed.append({"path": path, "uncertainty_pct": prov.get("uncertainty_pct"),
                            "source": prov.get("source")})
        for need in ("source", "method"):
            if not prov.get(need):
                msg = f"{path}.provenance.{need}: missing"
                (errors if require else warnings).append(msg)
    return errors, warnings, assumed


RUN_ONLY = "not runnable: "


def resolve_trace_path(path, base_dir=None) -> Path:
    p = Path(path)
    if not p.is_absolute() and base_dir is not None:
        p = Path(base_dir) / p
    return p


def _validate_trace_workload(raw, wl, page, base_dir, errors, warnings):
    tp = resolve_trace_path(wl["path"], base_dir)
    if not tp.is_file():
        errors.append(f"workload.path: trace file not found: {tp}")
        return None
    compute = [n["id"] for n in raw["nodes"] if n["role"] == "compute"]
    try:
        vt = load_trace(
            tp,
            sort=wl.get("sort", True),
            round_bytes=wl.get("round_bytes", False),
            time_scale=wl.get("time_scale", 1.0),
            page_size=page,
            node=None,
        )
    except TraceError as exc:
        errors.extend(exc.errors)
        return None
    # Multi-node replay: op nodes must name a compute node. Ops without a
    # node shard by request at replay time. Cross-node touches are legal:
    # placement is single-owner, so a non-owner touch reads through over the
    # static route without moving the page (no replication, no coherence).
    for o in vt.ops:
        nid = o.get("node")
        if nid is not None and nid not in compute:
            errors.append(f"workload.path: row {o['row']}: node {nid!r} is not a compute node "
                          f"{sorted(compute)}")
            return None
    if vt.unit_bytes is not None and vt.unit_bytes != page and not wl.get("round_bytes", False):
        errors.append(
            f"workload.path: trace unit is {vt.unit_bytes} bytes but scenario page size is {page}; "
            f"replay in the trace's native unit or set workload.round_bytes to map explicitly")
        return None
    for w in vt.report["warnings"]:
        warnings.append(f"workload.path: {w}")
    return vt


def _validate_faults(raw, errors, warnings):
    f = raw.get("faults", {}) or {}
    if f.get("node_failure_process", {}).get("enabled"):
        warnings.append("faults.node_failure_process: stochastic failures are not modeled; ignored")
    pl = f.get("packet_loss", {}) or {}
    if pl.get("ppm") and not pl.get("enabled"):
        warnings.append("faults.packet_loss: ppm is set but enabled is false; no loss modeled")
    tiers = {n.get("id") for n in raw.get("nodes", []) if n.get("id")}
    switches = {s.get("id") for s in raw.get("fabric", {}).get("switches", []) if s.get("id")}
    if isinstance(raw.get("fabric", {}).get("switch"), dict):
        switches.add("switch-0")
    link_ids = {l.get("id") for l in raw.get("fabric", {}).get("links", [])}
    nf, ld = f.get("node_failures", []) or [], f.get("link_degradations", []) or []
    by_node, by_link = {}, {}
    for i, w in enumerate(nf):
        tgt = w.get("node")
        if tgt in switches:
            errors.append(f"faults.node_failures[{i}]: switch failures are not modeled")
        elif tgt not in tiers:
            errors.append(f"faults.node_failures[{i}]: node '{tgt}' names no node")
        else:
            end = None if w.get("repair_ns") is None else w["time_ns"] + w["repair_ns"]
            by_node.setdefault(tgt, []).append((w["time_ns"], end, i))
    for i, w in enumerate(ld):
        if w.get("link") not in link_ids:
            errors.append(f"faults.link_degradations[{i}]: link '{w.get('link')}' names no link")
            continue
        if w["end_ns"] <= w["start_ns"]:
            errors.append(f"faults.link_degradations[{i}]: end_ns must exceed start_ns")
        by_link.setdefault(w["link"], []).append((w["start_ns"], w["end_ns"], i))
    for tgt, wins in by_node.items():
        wins.sort()
        for (s0, e0, i0), (s1, e1, i1) in zip(wins, wins[1:]):
            if e0 is None or s1 < e0:
                errors.append(f"faults.node_failures[{i0},{i1}]: overlapping windows on '{tgt}'")
    for tgt, wins in by_link.items():
        wins.sort()
        for (s0, e0, i0), (s1, e1, i1) in zip(wins, wins[1:]):
            if s1 < e0:
                errors.append(f"faults.link_degradations[{i0},{i1}]: overlapping windows on '{tgt}'")


def validate(raw, require_provenance: bool = False, for_run: bool = False, base_dir=None):
    """Schema + semantic validation. Returns (errors, warnings, assumed).

    Features the schema allows but the engine cannot execute are warnings for
    `validate` and errors when `for_run` is set.
    """
    errors = validate_schema(raw)
    warnings, assumed = [], []
    if errors:
        return errors, warnings, assumed
    perr, pwarn, assumed = _provenance_report(raw, require_provenance)
    errors += perr
    warnings += pwarn

    ids = [n["id"] for n in raw["nodes"]]
    if len(set(ids)) != len(ids):
        errors.append("nodes: ids must be unique")
    lids = [l["id"] for l in raw["fabric"]["links"]]
    if len(set(lids)) != len(lids):
        errors.append("fabric.links: ids must be unique")
    sw_ids = [s["id"] for s in raw["fabric"].get("switches", [])]
    endpoints_ok = set(ids) | set(sw_ids)
    for i, l in enumerate(raw["fabric"]["links"]):
        for end in ("from", "to"):
            if l[end] not in endpoints_ok:
                errors.append(f"fabric.links[{i}].{end}: unknown node or switch '{l[end]}'")
        if l["from"] == l["to"]:
            errors.append(f"fabric.links[{i}]: self-link from '{l['from']}' to itself is not allowed")
    if len(set(sw_ids)) != len(sw_ids):
        errors.append("fabric.switches: ids must be unique")

    page = raw.get("page_size_bytes", DEFAULT_PAGE_SIZE)
    compute = [n for n in raw["nodes"] if n["role"] == "compute"]
    memory = [n for n in raw["nodes"] if n["role"] == "memory"]
    if not compute:
        errors.append("nodes: at least one node with role 'compute' is required")
    for n in compute:
        if "local_memory" not in n:
            errors.append(f"nodes[{ids.index(n['id'])}]: compute node needs local_memory")
    pooled = [n for n in memory if "remote_memory" in n]
    for i, n in enumerate(raw["nodes"]):
        for key in ("local_memory", "remote_memory"):
            t = n.get(key)
            if not t:
                continue
            ps = t.get("page_size_bytes")
            if ps is not None and ps != page:
                errors.append(f"nodes[{i}].{key}.page_size_bytes: per-tier page sizes are not supported "
                              f"(scenario page size is {page})")
            if t["capacity_bytes"] < page:
                errors.append(f"nodes[{i}].{key}.capacity_bytes: smaller than one page ({page})")

    warm = raw.get("metrics", {}).get("warmup_ns", raw.get("warmup_ns", 0))
    if warm >= raw["duration_ns"]:
        errors.append("warmup_ns: must be smaller than duration_ns")
    if "warmup_ns" in raw and "warmup_ns" in raw.get("metrics", {}) and raw["warmup_ns"] != raw["metrics"]["warmup_ns"]:
        warnings.append("warmup_ns differs between top level and metrics; metrics.warmup_ns is used")

    # workload
    wl = raw["workload"]
    if wl.get("type") == "trace":
        _validate_trace_workload(raw, wl, page, base_dir, errors, warnings)
    else:
        if wl.get("profile") not in IMPLEMENTED_PROFILES:
            errors.append(RUN_ONLY + f"workload.profile: '{wl.get('profile')}' is not implemented "
                          f"(implemented: {', '.join(IMPLEMENTED_PROFILES)})")
        else:
            try:
                resolve_layer_classes(wl.get("model", {}))
            except GeometryError as exc:
                errors.extend(exc.errors)
        req = wl.get("requests", {})
        for k in ("arrival_rate_per_second", "prompt_tokens", "generated_tokens"):
            if k not in req:
                errors.append(f"workload.requests.{k}: required for kv_cache_decode")
        if req.get("generated_tokens", 1) < 1:
            errors.append("workload.requests.generated_tokens: must be at least 1")

    # policy
    pol = raw["policy"]["name"]
    effective = pol if pol in IMPLEMENTED_POLICIES else FALLBACK_POLICY
    if pol not in IMPLEMENTED_POLICIES:
        warnings.append(f"policy.name: '{pol}' is not implemented; falling back to "
                        f"'{FALLBACK_POLICY}' and recording the fallback in the manifest")
    try:
        _nodes, _pools, _links, _switches, _, _routes = _build_fabric(raw, errors)
    except (KeyError, TypeError, ValueError):
        # Node/link blocks already broken; those errors are recorded above.
        _nodes, _pools = [], {}
    if effective != "local_only":
        if not _pools and len(_nodes) < 2:
            errors.append("policy: remote policies need a memory pool or a peer compute node")
    params = raw["policy"].get("params", {})
    if pol in IMPLEMENTED_POLICIES:
        for k in params:
            if k not in known_params(pol):
                warnings.append(f"policy.params.{k}: unknown for '{pol}'; ignored")
        try:
            create_policy(pol, params)
        except ValueError as exc:
            errors.append(f"policy.params: {exc}")
    elif params:
        warnings.append(f"policy.params: ignored under '{effective}' fallback")

    # faults: explicit windows are modeled; the stochastic process is not
    _validate_faults(raw, errors, warnings)
    if raw.get("output", {}).get("format") == "parquet":
        warnings.append("output.format: parquet is not implemented; writing jsonl")
    run_only = [e for e in errors if e.startswith(RUN_ONLY)]
    if not for_run:
        errors = [e for e in errors if not e.startswith(RUN_ONLY)]
        warnings += [e for e in run_only]
    else:
        errors = [e.replace(RUN_ONLY, "", 1) if e.startswith(RUN_ONLY) else e for e in errors]
    return errors, warnings, assumed


def build_scenario(raw: dict, *, seed=None, policy=None, strict_policy=False, require_provenance=False,
                   base_dir=None) -> Scenario:
    raw = copy.deepcopy(raw)
    if seed is not None:
        raw["seed"] = int(seed)
    if policy is not None:
        raw["policy"] = {"name": policy}
    errors, warnings, assumed = validate(raw, require_provenance, for_run=True, base_dir=base_dir)
    requested = raw["policy"]["name"] if not errors else None
    if not errors and strict_policy and requested not in IMPLEMENTED_POLICIES:
        errors.append(f"policy.name: '{requested}' is not implemented (--strict-policy)")
    if errors:
        raise ScenarioError(errors)
    wl = raw["workload"]
    trace = None
    if wl.get("type") == "trace":
        trace = _validate_trace_workload(raw, wl, int(raw.get("page_size_bytes", DEFAULT_PAGE_SIZE)),
                                         base_dir, errors, warnings)
        if trace is None:
            raise ScenarioError(errors)
        classes, gsrc = [], "trace"
        requests = {}
    else:
        try:
            classes, gsrc = resolve_layer_classes(wl.get("model", {}))
        except GeometryError as exc:
            raise ScenarioError(exc.errors)
        requests = wl.get("requests", {})

    page = int(raw.get("page_size_bytes", DEFAULT_PAGE_SIZE))
    nodes, pools, links, switches, legacy_switch, routes = _build_fabric(raw, errors)
    if errors:
        raise ScenarioError(errors)
    if not switches and len(nodes) > 1:
        if pools:
            warnings.append("fabric.switch: absent on a multi-node run; bisection is unbounded "
                            "(only per-link and pool bandwidths constrain)")
        else:
            warnings.append("fabric.switch: absent on a peer-only multi-node run; bisection is "
                            "unbounded (only per-link and endpoint bandwidths constrain)")
    switch = switches.get("switch-0") if legacy_switch else None
    fraw = raw.get("faults", {}) or {}
    fpl = fraw.get("packet_loss", {}) or {}
    fault_spec = {
        "node_failures": [dict(w) for w in fraw.get("node_failures", []) or []],
        "link_degradations": [dict(w) for w in fraw.get("link_degradations", []) or []],
        "packet_loss_ppm": int(fpl.get("ppm", 0)) if fpl.get("enabled") else 0,
        "link_loss_ppm": {lid: int(l.loss_ppm) for lid, l in links.items()
                          if l.loss_ppm is not None},
    }
    effective = requested if requested in IMPLEMENTED_POLICIES else FALLBACK_POLICY
    reason = None if effective == requested else (
        f"'{requested}' is not implemented; ran '{effective}' instead")
    metrics = raw.get("metrics", {})
    warm = int(metrics.get("warmup_ns", raw.get("warmup_ns", 0)))
    interval = int(metrics.get("sample_interval_ns", max(raw["duration_ns"] // 100, 1)))
    return Scenario(
        raw=raw, name=raw["name"], hash=scenario_hash(raw), seed=int(raw["seed"]),
        duration_ns=int(raw["duration_ns"]), warmup_ns=warm, page_size=page, nodes=nodes, pools=pools,
        links=links, switches=switches, routes=routes, switch=switch,
        layer_classes=classes, geometry_source=gsrc, requests=requests,
        workload_type=wl.get("type", "synthetic"), trace=trace,
        percentiles=tuple(float(p) for p in metrics.get("percentiles", DEFAULT_PERCENTILES)),
        sample_interval_ns=interval, policy_requested=requested, policy_effective=effective,
        policy_params=raw["policy"].get("params", {}), fallback_reason=reason,
        cost_model=raw.get("cost_model", {}), output=raw.get("output", {}),
        warnings=warnings, assumed=assumed, faults=fault_spec,
    )
