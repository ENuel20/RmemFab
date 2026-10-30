"""Scenario loading, canonical hashing, semantic validation, and normalization."""
from __future__ import annotations

import copy
import hashlib
import json
import math
from dataclasses import dataclass, field
from pathlib import Path

from .schema import validate_schema

DEFAULT_PAGE_SIZE = 2 * 1024 * 1024
IMPLEMENTED_POLICIES = ("local_only", "swap_remote")
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


@dataclass
class PoolSpec:
    id: str
    tier: TierSpec


@dataclass
class LinkSpec:
    id: str
    node: str
    latency_ns: float
    bandwidth_bytes_per_ns: float
    in_flight_bytes: int | None
    queue_depth_bytes: int | None
    bidirectional: bool


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
    pool: PoolSpec | None
    links: dict  # node id -> LinkSpec
    model: dict
    requests: dict
    percentiles: tuple
    sample_interval_ns: int
    policy_requested: str
    policy_effective: str
    policy_params: dict
    fallback_reason: str | None
    cost_model: dict
    output: dict
    warnings: list = field(default_factory=list)
    assumed: list = field(default_factory=list)

    @property
    def kv_bytes_per_token(self) -> int:
        m = self.model
        return int(2 * m["layers"] * m["kv_heads"] * m["head_dim"] * m["dtype_bytes"])


# --------------------------------------------------------------- semantics ---
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


RUN_ONLY = "not runnable in Phase 1: "


def validate(raw, require_provenance: bool = False, for_run: bool = False):
    """Schema + semantic validation. Returns (errors, warnings, assumed).

    Features the schema allows but Phase 1 cannot execute are warnings for
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
    for i, l in enumerate(raw["fabric"]["links"]):
        for end in ("from", "to"):
            if l[end] not in ids:
                errors.append(f"fabric.links[{i}].{end}: unknown node '{l[end]}'")

    page = raw.get("page_size_bytes", DEFAULT_PAGE_SIZE)
    compute = [n for n in raw["nodes"] if n["role"] == "compute"]
    memory = [n for n in raw["nodes"] if n["role"] == "memory"]
    if not compute:
        errors.append("nodes: at least one node with role 'compute' is required")
    for n in compute:
        if "local_memory" not in n:
            errors.append(f"nodes[{ids.index(n['id'])}]: compute node needs local_memory")
    pooled = [n for n in memory if "remote_memory" in n]
    if len(pooled) > 1:
        errors.append("nodes: Phase 1 supports a single remote memory pool")
    for i, n in enumerate(raw["nodes"]):
        for key in ("local_memory", "remote_memory"):
            t = n.get(key)
            if not t:
                continue
            ps = t.get("page_size_bytes")
            if ps is not None and ps != page:
                errors.append(f"nodes[{i}].{key}.page_size_bytes: per-tier page sizes are not supported in "
                              f"Phase 1 (scenario page size is {page})")
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
        errors.append(RUN_ONLY + "workload.type: trace replay arrives in Phase 2")
    else:
        if wl["profile"] not in IMPLEMENTED_PROFILES:
            errors.append(RUN_ONLY + f"workload.profile: '{wl['profile']}' arrives in Phase 2 "
                          f"(Phase 1 implements {', '.join(IMPLEMENTED_PROFILES)})")
        model = wl.get("model", {})
        for k in ("layers", "kv_heads", "head_dim", "dtype_bytes"):
            if k not in model:
                errors.append(f"workload.model.{k}: required for kv_cache_decode")
        req = wl.get("requests", {})
        for k in ("arrival_rate_per_second", "prompt_tokens", "generated_tokens"):
            if k not in req:
                errors.append(f"workload.requests.{k}: required for kv_cache_decode")
        if req.get("generated_tokens", 1) < 1:
            errors.append("workload.requests.generated_tokens: must be at least 1")

    # policy
    pol = raw["policy"]["name"]
    if pol not in IMPLEMENTED_POLICIES:
        warnings.append(f"policy.name: '{pol}' arrives in Phase 3; Phase 1 falls back to "
                        f"'{FALLBACK_POLICY}' and records the fallback in the manifest")
    if pol == "swap_remote" or (pol not in IMPLEMENTED_POLICIES):
        if not pooled:
            errors.append("policy: remote policies need a memory node with remote_memory")
        else:
            linked = {l["from"] for l in raw["fabric"]["links"]} | {l["to"] for l in raw["fabric"]["links"]}
            for n in compute:
                if n["id"] not in linked:
                    errors.append(f"fabric.links: compute node '{n['id']}' has no link to the pool")
    if raw["policy"].get("params") and pol in IMPLEMENTED_POLICIES:
        warnings.append(f"policy.params: '{pol}' takes no parameters; ignored")

    # features outside Phase 1
    f = raw.get("faults", {})
    if f.get("node_failures") or f.get("link_degradations") or f.get("packet_loss", {}).get("enabled") \
            or f.get("node_failure_process", {}).get("enabled"):
        warnings.append("faults: fault injection arrives in Phase 5; configured faults are ignored")
    if any(l.get("loss_ppm") for l in raw["fabric"]["links"]):
        warnings.append("fabric.links[].loss_ppm: loss is not modeled in Phase 1; ignored")
    if raw.get("output", {}).get("format") == "parquet":
        warnings.append("output.format: parquet is not implemented; writing jsonl")
    run_only = [e for e in errors if e.startswith(RUN_ONLY)]
    if not for_run:
        errors = [e for e in errors if not e.startswith(RUN_ONLY)]
        warnings += [e for e in run_only]
    else:
        errors = [e.replace(RUN_ONLY, "", 1) if e.startswith(RUN_ONLY) else e for e in errors]
    return errors, warnings, assumed


def build_scenario(raw: dict, *, seed=None, policy=None, strict_policy=False, require_provenance=False) -> Scenario:
    raw = copy.deepcopy(raw)
    if seed is not None:
        raw["seed"] = int(seed)
    if policy is not None:
        raw["policy"] = {"name": policy}
    errors, warnings, assumed = validate(raw, require_provenance, for_run=True)
    requested = raw["policy"]["name"] if not errors else None
    if not errors and strict_policy and requested not in IMPLEMENTED_POLICIES:
        errors.append(f"policy.name: '{requested}' is not implemented in Phase 1 (--strict-policy)")
    if errors:
        raise ScenarioError(errors)

    page = int(raw.get("page_size_bytes", DEFAULT_PAGE_SIZE))
    nodes, pool = [], None
    for n in raw["nodes"]:
        if n["role"] == "compute":
            nodes.append(NodeSpec(n["id"], _tier(n["local_memory"])))
        elif "remote_memory" in n:
            pool = PoolSpec(n["id"], _tier(n["remote_memory"]))
    links = {}
    for l in raw["fabric"]["links"]:
        for cn in nodes:
            peer = pool.id if pool else None
            if {l["from"], l["to"]} == {cn.id, peer} and cn.id not in links:
                links[cn.id] = LinkSpec(l["id"], cn.id, float(l["latency_ns"]), float(l["bandwidth_bytes_per_ns"]),
                                        l.get("in_flight_bytes"), l.get("queue_depth_bytes"),
                                        bool(l.get("bidirectional", True)))
    effective = requested if requested in IMPLEMENTED_POLICIES else FALLBACK_POLICY
    reason = None if effective == requested else (
        f"'{requested}' is a later-phase policy; Phase 1 ran '{effective}' instead")
    metrics = raw.get("metrics", {})
    warm = int(metrics.get("warmup_ns", raw.get("warmup_ns", 0)))
    interval = int(metrics.get("sample_interval_ns", max(raw["duration_ns"] // 100, 1)))
    wl = raw["workload"]
    return Scenario(
        raw=raw, name=raw["name"], hash=scenario_hash(raw), seed=int(raw["seed"]),
        duration_ns=int(raw["duration_ns"]), warmup_ns=warm, page_size=page, nodes=nodes, pool=pool,
        links=links, model=wl.get("model", {}), requests=wl.get("requests", {}),
        percentiles=tuple(float(p) for p in metrics.get("percentiles", DEFAULT_PERCENTILES)),
        sample_interval_ns=interval, policy_requested=requested, policy_effective=effective,
        policy_params=raw["policy"].get("params", {}), fallback_reason=reason,
        cost_model=raw.get("cost_model", {}), output=raw.get("output", {}),
        warnings=warnings, assumed=assumed,
    )
