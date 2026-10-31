"""Canonical summary helpers."""
from __future__ import annotations

import json


def roundf(obj, nd: int = 6):
    if isinstance(obj, float):
        r = round(obj, nd)
        return int(r) if r.is_integer() and abs(r) < 1e15 else r
    if isinstance(obj, dict):
        return {k: roundf(v, nd) for k, v in obj.items()}
    if isinstance(obj, list):
        return [roundf(v, nd) for v in obj]
    return obj


def canonical(obj) -> str:
    return json.dumps(roundf(obj), sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def _human_replay(s: dict) -> str:
    a, o, t = s["access"], s["ops"], s["time"]
    L = [f"{s['scenario']}  policy={s['policy']['effective']}  seed={s['seed']}  label={s['workload_label']}  "
         f"hash={s['scenario_hash'][:12]}"]
    if s["policy"].get("fallback_reason"):
        L.append(f"  NOTE: {s['policy']['fallback_reason']}")
    L.append(f"  virtual time {t['virtual_time_ns']/1e9:.3f}s  events {s['events_processed']}  "
             f"workload {s['workload']['type']}/{s['workload']['profile']}")
    ex = o["executed"]
    L.append(f"  ops: alloc {ex['alloc']}  free {ex['free']}  read {ex['read']}  write {ex['write']}  "
             f"ignored {sum(o['ignored_recorded_ops'].values())}  anomalies {sum(o['anomalies'].values())}  "
             f"alloc-failed {o['alloc_failed']}")
    lat = a["latency_ns"]
    ps = "  ".join(f"{k} {v:,.0f}" for k, v in lat.items() if k.startswith("p"))
    L.append(f"  access latency ns: mean {lat['mean']:,.1f}  {ps}  max {lat['max']:,.0f}")
    ol = s["op_latency_ns"]
    L.append(f"  op latency ms: mean {ol['mean']/1e6:,.3f}  p99 {ol.get('p99', 0)/1e6:,.3f}  max {ol['max']/1e6:,.3f}")
    L.append(f"  accesses {a['count']:,}  local-hit {a['local_hit_ratio']:.4f}  remote-hit {a['remote_hit_ratio']:.4f}  "
             f"stall {a['stall_ns']/1e9:.4f}s")
    tr = s["traffic"]
    L.append(f"  remote traffic: read {tr['remote_read_bytes']/2**30:.2f} GiB  write {tr['remote_write_bytes']/2**30:.2f} GiB")
    for nid, v in s["memory"].items():
        L.append(f"  local {nid}: bw util {v['bandwidth_utilization']:.3f}  peak {v['peak_used_pages']}/{v['capacity_pages']} pages")
    for lid, v in s["links"].items():
        L.append(f"  link {lid}: util {v['utilization']:.3f}  max queue {v['max_queue_bytes']/2**20:.1f} MiB")
    r = s["replay"]
    if "sequence_matches" in r:
        L.append(f"  alloc/free sequence: {'MATCHES recorded trace' if r['sequence_matches'] else 'does NOT match recorded trace'}"
                 f" ({r['executed_alloc_free_records']}/{r['recorded_alloc_free_records']} records)")
    return "\n".join(L)


def human(summary: dict) -> str:
    s = summary
    if s.get("workload_kind") == "replay":
        return _human_replay(s)
    a, r, t = s["access"], s["requests"], s["time"]
    L = []
    L.append(f"{s['scenario']}  policy={s['policy']['effective']}  seed={s['seed']}  hash={s['scenario_hash'][:12]}")
    if s["policy"].get("fallback_reason"):
        L.append(f"  NOTE: {s['policy']['fallback_reason']}")
    L.append(f"  virtual time {t['virtual_time_ns']/1e9:.3f}s  steady window {t['steady_window_ns']/1e9:.3f}s  "
             f"events {s['events_processed']}")
    L.append(f"  requests: arrived {r['arrived']}  completed {r['completed']}  rejected {r['rejected']}  "
             f"in-flight {r['in_flight_at_end']}  queued {r['queued_at_end']}")
    lat = a["latency_ns"]
    ps = "  ".join(f"{k} {v:,.0f}" for k, v in lat.items() if k.startswith("p"))
    L.append(f"  access latency ns: mean {lat['mean']:,.1f}  {ps}  max {lat['max']:,.0f}")
    st = s["decode_step_latency_ns"]
    L.append(f"  decode step ms: mean {st['mean']/1e6:,.3f}  p50 {st.get('p50',0)/1e6:,.3f}  p95 {st.get('p95',0)/1e6:,.3f}"
             f"  p99 {st.get('p99',0)/1e6:,.3f}")
    L.append(f"  accesses {a['count']:,}  local-hit {a['local_hit_ratio']:.4f}  remote-hit {a['remote_hit_ratio']:.4f}  "
             f"miss {a['miss_ratio']:.4f}  stall {a['stall_ns']/1e9:.4f}s")
    tr = s["traffic"]
    L.append(f"  remote traffic: read {tr['remote_read_bytes']/2**30:.2f} GiB  write {tr['remote_write_bytes']/2**30:.2f} GiB"
             f"  migration {tr['migration_bytes']/2**30:.2f} GiB")
    for nid, v in s["memory"].items():
        L.append(f"  local {nid}: bw util {v['bandwidth_utilization']:.3f}  peak {v['peak_used_pages']}/{v['capacity_pages']} pages")
    for lid, v in s["links"].items():
        L.append(f"  link {lid}: util {v['utilization']:.3f}  max queue {v['max_queue_bytes']/2**20:.1f} MiB  "
                 f"congested {v['congested_events']}")
    if s["requests"]["latency_ns"]["count"]:
        rl = s["requests"]["latency_ns"]
        L.append(f"  request latency ms: mean {rl['mean']/1e6:,.1f}  p50 {rl.get('p50', 0)/1e6:,.1f}  "
                 f"p99 {rl.get('p99', 0)/1e6:,.1f}  throughput {s['requests']['throughput_per_s']:.2f} req/s")
    return "\n".join(L)
