"""Deterministic fault injection: degradation windows, node failures, loss.

All fault timing comes from the scenario (explicit windows), so identical
scenarios replay identically. Packet loss draws come from the dedicated
"faults" RNG stream, which no other subsystem consumes.

Semantics (also recorded in each run manifest):
- Link degradation rescales server bandwidth exactly at window edges and
  multiplies fixed link latency for transfers issued inside the window.
- A transfer issued while its source node or destination tier is down
  stalls to the tier's recovery time (clamped to run end).
- Retransmission assumes a reliable transport: lost attempts waste bytes
  and add one RTO (one round trip = 2x path fixed latency) each, and a
  transfer is delivered after at most MAX_ATTEMPTS simulated draws.
- Retries are computed synchronously at issue: no other traffic is
  interleaved on the occupied servers during the RTO gap.
- Failures gate issue at event boundaries; in-flight steps complete.
"""
from __future__ import annotations

from .rng import make_rng


class FaultModel:
    MAX_ATTEMPTS = 8

    def __init__(self, node_failures, link_degradations, packet_loss_ppm,
                 link_loss_ppm, seed, duration_ns):
        # node_failures: [{time_ns, node, repair_ns|None, reason}]
        # link_degradations: [{start_ns, end_ns, link, bandwidth_factor|None,
        #   latency_factor|None}]; None factor == 1.0. Windows are validated
        # (ids exist, end > start, no same-target overlap) in scenario.py.
        self.node_windows = {}
        for f in node_failures:
            start = int(f["time_ns"])
            rep = f.get("repair_ns")
            end = None if rep is None else start + int(rep)
            self.node_windows.setdefault(f["node"], []).append(
                (start, end, f.get("reason", "")))
        for w in self.node_windows.values():
            w.sort()
        self.link_windows = {}
        for d in link_degradations:
            self.link_windows.setdefault(d["link"], []).append(
                (int(d["start_ns"]), int(d["end_ns"]),
                 float(d.get("bandwidth_factor", 1.0)),
                 float(d.get("latency_factor", 1.0))))
        for w in self.link_windows.values():
            w.sort()
        self.ppm = int(packet_loss_ppm)
        self.link_ppm = dict(link_loss_ppm)
        self.duration = int(duration_ns)
        self.rng = make_rng(int(seed), "faults")
        # Counters (reported under summary["degraded"]).
        self.loss_events = 0
        self.retx_count = 0
        self.retx_bytes = 0
        self.retx_delay_ns = 0.0
        self.stalled_bytes = 0
        self.stalled_transfers = 0

    # ------------------------------------------------------------ queries ---
    def link_factors(self, lid, now):
        """(bandwidth_factor, latency_factor) active for `lid` at `now`."""
        for start, end, bw_f, lat_f in self.link_windows.get(lid, ()):
            if start <= now < end:
                return bw_f, lat_f
        return 1.0, 1.0

    def recovery_of(self, tier, now):
        """Recovery time if `tier` is down at `now`, else None. A failure
        without repair_ns never recovers (returns +inf)."""
        for start, end, _ in self.node_windows.get(tier, ()):
            if now >= start and (end is None or now < end):
                return float("inf") if end is None else float(end)
        return None

    def down(self, tier, now):
        return self.recovery_of(tier, now) is not None

    def active_count(self, now):
        n = 0
        for w in self.node_windows.values():
            for start, end, _ in w:
                if start <= now and (end is None or now < end):
                    n += 1
        for w in self.link_windows.values():
            for start, end, _, _ in w:
                if start <= now < end:
                    n += 1
        return n

    def stall_until(self, now, src, dst):
        """Issue time for a transfer between `src` and `dst` starting at
        `now`: stalled past any endpoint outage, clamped to run end."""
        t = float(now)
        for tier in (src, dst):
            rec = self.recovery_of(tier, now)
            if rec is not None:
                t = max(t, rec)
        return min(t, float(self.duration))

    def loss_ppm_for(self, lid):
        if lid in self.link_ppm:
            return self.link_ppm[lid]
        return self.ppm

    def draw_loss(self, lid):
        ppm = self.loss_ppm_for(lid)
        if ppm <= 0:
            return False
        return self.rng.random() < ppm / 1e6

    def windows(self):
        out = []
        for node, w in sorted(self.node_windows.items()):
            for start, end, reason in w:
                out.append({"type": "node_failure", "target": node,
                            "start_ns": start, "end_ns": end, "reason": reason})
        for lid, w in sorted(self.link_windows.items()):
            for start, end, bw_f, lat_f in w:
                out.append({"type": "link_degradation", "target": lid,
                            "start_ns": start, "end_ns": end,
                            "bandwidth_factor": bw_f, "latency_factor": lat_f})
        return out

    def edges(self):
        """Window edges as (time_ns, kind, payload) in time order, for the
        run loops to schedule (engine) or apply (replay)."""
        out = []
        for node, w in self.node_windows.items():
            for start, end, reason in w:
                out.append((start, "node_fail",
                            {"node": node, "reason": reason,
                             "recovery_ns": end}))
                if end is not None:
                    out.append((end, "node_recover",
                                {"node": node, "downtime_ns": end - start}))
        for lid, w in self.link_windows.items():
            for start, end, bw_f, lat_f in w:
                out.append((start, "degrade_begin",
                            {"link": lid, "bandwidth_factor": bw_f,
                             "latency_factor": lat_f}))
                out.append((end, "degrade_end", {"link": lid}))
        out.sort(key=lambda e: e[0])
        return out

    @staticmethod
    def zero_counters():
        return {"loss_events": 0, "retransmissions": 0, "retransmit_bytes": 0,
                "retransmit_delay_ns": 0, "stalled_transfers": 0, "stalled_bytes": 0}

    def counters(self):
        return {"loss_events": self.loss_events,
                "retransmissions": self.retx_count,
                "retransmit_bytes": self.retx_bytes,
                "retransmit_delay_ns": self.retx_delay_ns,
                "stalled_transfers": self.stalled_transfers,
                "stalled_bytes": self.stalled_bytes}
