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

metrics allows ONLY: percentiles[] (e.g. [50, 95, 99]),
sample_interval_ns, warmup_ns. Things the user wants to SEE after the run
(p99 latency, contention, utilization, breakdowns) are computed outputs
shown by the dashboard -- they are NEVER config fields, so do not add
them. When unsure a field exists, omit it: the schema rejects unknown
properties.

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
Valid params per policy (omit params entirely for defaults):
hot_cold{k>=1, hot_threshold, cold_threshold} with
0 <= cold_threshold < hot_threshold (defaults k=2, hot=3, cold=1);
frequency_aware{k>=1} (default k=2);
predictive_prefetch{degree>=1, stride!=0, max_in_flight>=1}
(defaults degree=1, stride=1, max_in_flight=64);
local_only and swap_remote take NO params. Never invent param names.

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

SUGGEST_SUFFIX = """When you propose a configuration change, ALSO emit it as a
JSON patch in exactly one fenced block:

```patch
[{"op": "replace", "path": "/seed", "value": 11}]
```

Ops are replace/add/remove against the run's scenario (JSON-pointer paths),
and the scenario JSON is appended after this suffix: verify every path
against it. Telemetry field names (policy.requested/policy.effective) do
NOT exist in the scenario and will be rejected. Common patchable paths:
/policy/name for the policy string, /policy/params for its parameter
object, /seed for the seed. Prefer the smallest change that tests the
user's question; a directional suggestion the user will run and compare
is itself the safe action, and the server revalidates before anything
runs, so never claim a change was applied. Only refuse a patch when the
request contradicts the telemetry (for example, it names a policy the
run did not use): say so and emit no patch."""


def extract_patch_block(text: str):
    """Return the first ```patch fenced payload as a list, None when absent.

    Raises ValueError when the fence is present but the payload is not a
    JSON array (the caller reports this as an invalid suggestion, never as
    a server error).
    """
    start = text.find("```patch")
    if start < 0:
        return None
    payload = text[start + len("```patch"):]
    end = payload.find("```")
    if end < 0:
        raise ValueError("unterminated ```patch block")
    try:
        ops = json.loads(payload[:end])
    except json.JSONDecodeError as exc:
        raise ValueError(f"patch block is not JSON: {exc}") from None
    if not isinstance(ops, list):
        raise ValueError("patch block must be a JSON array of ops")
    return ops


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
