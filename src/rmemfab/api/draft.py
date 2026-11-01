"""NL-to-scenario drafting over Baseten (Muse-family models only).

The model proposes; the server disposes. Every draft is validated with the
real validator before it is stored or returned as usable, and invalid drafts
come back with the model's output plus the validation errors -- never
silently repaired, never runnable.
"""
from __future__ import annotations

import json

SYSTEM = """You draft RmemFab simulation scenarios as JSON. Output ONLY the JSON
object, no prose, no fences.

Required top level: version "0.1", name (string), seed (int), duration_ns
(int), nodes[] , fabric{}, workload{}, policy{}. Optional: page_size_bytes
(default 2097152), warmup_ns, metrics{}, output{}, cost_model{}.

nodes[]: {id, role} where role is compute or memory. A compute node needs
local_memory{capacity_bytes, latency_ns, bandwidth_bytes_per_ns}. A memory
node needs remote_memory{capacity_bytes, latency_ns, bandwidth_bytes_per_ns}.
Capacities are BYTES. Every pool must be reachable from every compute node
by directed links or validation fails.

fabric{links[]}: each {id, from, to, latency_ns, bandwidth_bytes_per_ns,
bidirectional?}. Endpoints name node ids or switch ids. Optional single
"switch"{bandwidth_bytes_per_ns, latency_ns?} OR "switches"[{id,
bandwidth_bytes_per_ns, latency_ns?}] -- both together are rejected.

workload: {type: "synthetic", profile: "kv_cache_decode",
model{layers, attention_heads, kv_heads, head_dim, dtype_bytes},
requests{arrival_rate_per_second, concurrency, prompt_tokens,
generated_tokens}} or {type: "trace", path} where path is server-visible.

policy: {name} with name in local_only, swap_remote, hot_cold,
frequency_aware, predictive_prefetch, plus optional params{}.

Units are bytes, nanoseconds, bytes/ns. Never invent fields: the schema
rejects unknown properties. When a parent scenario is supplied, change as
little as possible to satisfy the request."""


def build_messages(prompt: str, parent: dict | None) -> list:
    user = prompt.strip()
    if parent is not None:
        user += ("\n\nParent scenario to modify minimally:\n" +
                 json.dumps(parent))
    return [{"role": "system", "content": SYSTEM},
            {"role": "user", "content": user}]


CHAT_SYSTEM = """You explain RmemFab simulation results. Rules: answer ONLY from
the run telemetry provided below; quote exact numbers with units; say plainly
when the data does not support an answer; never invent metrics, events, or
page identities. Keep answers short unless asked for detail."""


def telemetry_brief(detail: dict) -> str:
    """Compact grounded context: summary essentials, bounded size."""
    s = detail.get("summary") or {}
    m = detail.get("manifest") or {}
    brief = {
        "run_id": detail.get("run_id"), "status": detail.get("status"),
        "scenario": s.get("scenario"), "seed": s.get("seed"),
        "policy": (s.get("policy") or {}),
        "access": {k: (s.get("access") or {}).get(k) for k in (
            "count", "local_hits", "remote_hits", "bypass_reads", "misses",
            "local_hit_ratio", "remote_hit_ratio", "stall_ns")},
        "latency_ns": ((s.get("access") or {}).get("latency_ns") or {}),
        "traffic": s.get("traffic"),
        "links": {lid: {k: l.get(k) for k in (
            "bytes_in", "bytes_out", "utilization", "max_queue_bytes")}
            for lid, l in (s.get("links") or {}).items()},
        "memory": {nid: {k: n.get(k) for k in (
            "reads", "local_hits", "remote_hits", "peak_used_pages",
            "final_used_pages")} for nid, n in (s.get("memory") or {}).items()},
        "requests": s.get("requests"),
        "warnings": m.get("warnings", []),
        "limitations": (m.get("limitations") or [])[:4],
    }
    return json.dumps(brief)
