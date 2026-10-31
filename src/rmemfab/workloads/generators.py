"""Synthetic op-stream generators: kv decode, prefill, sparse attention, MoE.

Every generator is a lazy iterator of ops (ts_ns, op, page_id, bytes, node, request_id).
The same iterator feeds the replay engine directly (on-demand) and `rmemfab generate`
(precomputed), so both modes produce identical sequences by construction
(ARCHITECTURE.md, workload source).
"""
from __future__ import annotations

import heapq
import math

import numpy as np

from ..core.rng import make_rng
from .synthetic import kv_bytes_per_token
from .trace import normalize_bytes

DEFAULTS = {"tokens_per_second": 50.0, "prefill_tokens_per_second": 5000.0}


class Params:
    """Resolved generator parameters; anything not given by the scenario is listed in `defaulted`."""

    def __init__(self, sc):
        self.sc = sc
        self.page = sc.page_size
        self.model, self.req, self.sparsity = sc.model, sc.requests, sc.sparsity
        self.defaulted = []
        self.rounded = {"records": 0, "added_bytes": 0}
        self.profile = sc.profile
        self.nodes = [n.id for n in sc.nodes]
        prof, prompt = sc.profile, int(sc.requests.get("prompt_tokens", 0))
        tps = self._get("tokens_per_second", self.req, track=prof != "prefill")
        self.token_ns = max(1, int(1e9 / tps))
        ptps = self._get("prefill_tokens_per_second", self.req,
                         track=prof in ("kv_cache_decode", "sparse_attention", "prefill") or (prof == "moe" and prompt > 0))
        self.prefill_ns = lambda tokens: max(1, int(tokens * 1e9 / ptps))
        self.rate = float(self.req["arrival_rate_per_second"])
        self.prompt = int(self.req.get("prompt_tokens", 0))
        self.gen = int(self.req.get("generated_tokens", 0))
        if self.profile in ("kv_cache_decode", "sparse_attention", "prefill"):
            self.kvtok = kv_bytes_per_token(self.model)
        default_block = 1 if self.profile == "sparse_attention" else 16
        self.block_pages = int(self._get("kv_block_pages", self.req, default_block,
                                         track=self.profile in ("kv_cache_decode", "sparse_attention")))

    def _get(self, key, d, default=None, track=True):
        if key in d:
            return d[key]
        default = DEFAULTS[key] if default is None else default
        if track:
            self.defaulted.append({"parameter": f"workload.requests.{key}", "value": default})
        return default

    def size(self, nbytes: int) -> int:
        nb, ch = normalize_bytes(max(1, int(nbytes)), self.page)
        if ch:
            self.rounded["records"] += 1
            self.rounded["added_bytes"] += nb - int(nbytes)
        return nb


def _req_rng(seed, idx):
    return np.random.Generator(np.random.PCG64(np.random.SeedSequence(seed, spawn_key=(0, 1 + idx))))


# ---------------------------------------------------------------- per-request streams
def _kv_blocks_for(p: Params, tokens: int) -> int:
    block_bytes = p.block_pages * p.page
    return max(0, -(-(tokens * p.kvtok) // block_bytes))


def _kv_decode(p, idx, node, t0, rng):
    rid, block = f"req-{idx}", p.block_pages * p.page
    t = t0
    nblocks = _kv_blocks_for(p, p.prompt)
    for b in range(nblocks):
        yield (t, "alloc", f"{rid}/kv{b}", block, node, rid)
        yield (t, "write", f"{rid}/kv{b}", block, node, rid)
    t += p.prefill_ns(p.prompt)
    for i in range(p.gen):
        t += p.token_ns
        need = _kv_blocks_for(p, p.prompt + i + 1)
        while nblocks < need:
            yield (t, "alloc", f"{rid}/kv{nblocks}", block, node, rid)
            yield (t, "write", f"{rid}/kv{nblocks}", block, node, rid)
            nblocks += 1
        for b in range(nblocks):
            yield (t, "read", f"{rid}/kv{b}", block, node, rid)
    t += p.token_ns
    for b in range(nblocks):
        yield (t, "free", f"{rid}/kv{b}", block, node, rid)


def _prefill(p, idx, node, t0, rng):
    rid = f"req-{idx}"
    L = int(p.model["layers"])
    dur = p.prefill_ns(p.prompt)
    dt = max(1, dur // L)
    act = p.size(p.prompt * p.model["hidden_size"] * p.model["dtype_bytes"])
    kv_layer = p.size(p.prompt * 2 * p.model["kv_heads"] * p.model["head_dim"] * p.model["dtype_bytes"])
    wbytes = _weight_bytes(p)
    for l in range(L):
        t = t0 + l * dt
        yield (t, "read", f"w/{node}/L{l}", wbytes, node, rid)
        yield (t, "alloc", f"{rid}/act{l}", act, node, rid)
        yield (t, "write", f"{rid}/act{l}", act, node, rid)
        yield (t, "alloc", f"{rid}/kv{l}", kv_layer, node, rid)
        yield (t, "write", f"{rid}/kv{l}", kv_layer, node, rid)
        yield (t + dt, "free", f"{rid}/act{l}", act, node, rid)
    t = t0 + L * dt
    for l in range(L):
        yield (t, "free", f"{rid}/kv{l}", kv_layer, node, rid)


def _weight_bytes(p):
    m = p.model
    if "weight_bytes_per_layer" in m:
        return p.size(m["weight_bytes_per_layer"])
    if not any(d["parameter"] == "workload.model.weight_bytes_per_layer" for d in p.defaulted):
        p.defaulted.append({"parameter": "workload.model.weight_bytes_per_layer",
                            "value": "12 * hidden_size^2 * dtype_bytes (dense-layer approximation)"})
    return p.size(12 * m["hidden_size"] ** 2 * m["dtype_bytes"])


def _sparse(p, idx, node, t0, rng):
    rid, block = f"req-{idx}", p.block_pages * p.page
    win = int(p.sparsity["window_tokens"])
    glob = int(p.sparsity.get("global_tokens", 0))
    tok_per_block = max(1, block // p.kvtok)
    t = t0
    nblocks = _kv_blocks_for(p, p.prompt)
    for b in range(nblocks):
        yield (t, "alloc", f"{rid}/kv{b}", block, node, rid)
        yield (t, "write", f"{rid}/kv{b}", block, node, rid)
    t += p.prefill_ns(p.prompt)
    for i in range(p.gen):
        t += p.token_ns
        ctx = p.prompt + i + 1
        need = _kv_blocks_for(p, ctx)
        while nblocks < need:
            yield (t, "alloc", f"{rid}/kv{nblocks}", block, node, rid)
            yield (t, "write", f"{rid}/kv{nblocks}", block, node, rid)
            nblocks += 1
        lo_tok = max(0, ctx - win)
        blocks = set(range(lo_tok // tok_per_block, (ctx - 1) // tok_per_block + 1))
        if glob and lo_tok > 0:
            for tok in rng.integers(0, lo_tok, size=glob):
                blocks.add(int(tok) // tok_per_block)
        for b in sorted(blocks):
            yield (t, "read", f"{rid}/kv{b}", block, node, rid)
    t += p.token_ns
    for b in range(nblocks):
        yield (t, "free", f"{rid}/kv{b}", block, node, rid)


def moe_popularity(model, rng, layer_count):
    """Per-layer expert probability vectors (rank order shuffled per layer so hot experts differ)."""
    n = int(model["experts"])
    dist = model.get("popularity_distribution", "zipf")
    skew = float(model.get("popularity_skew", 1.0))
    out = []
    for _ in range(layer_count):
        if dist == "uniform":
            w = np.ones(n)
        elif dist == "custom":
            w = np.asarray(model["popularity_weights"], dtype=np.float64)
        else:
            w = 1.0 / np.arange(1, n + 1, dtype=np.float64) ** skew
            w = w[rng.permutation(n)]
        out.append(w / w.sum())
    return out


def _moe(p, idx, node, t0, rng, pop):
    rid = f"req-{idx}"
    m = p.model
    L = len(pop)
    k, n = int(m["top_k"]), int(m["experts"])
    esize = p.size(m["expert_size_bytes"])
    t = t0
    if p.prompt > 0:
        # Prefill touches the union of experts selected by prompt_tokens tokens; an expert with
        # per-token selection probability q is touched with probability 1 - (1 - q)^T.
        t += p.prefill_ns(p.prompt)
        for l in range(L):
            q = np.minimum(1.0, pop[l] * k)
            hit = rng.random(n) < 1.0 - (1.0 - q) ** p.prompt
            for e in np.nonzero(hit)[0]:
                yield (t, "read", f"expert/{node}/L{l}/E{int(e)}", esize, node, rid)
    dt = max(1, p.token_ns // max(L, 1))
    for i in range(p.gen):
        t += p.token_ns
        for l in range(L):
            chosen = rng.choice(n, size=k, replace=False, p=pop[l])
            for e in sorted(int(c) for c in chosen):
                yield (t + l * dt, "read", f"expert/{node}/L{l}/E{e}", esize, node, rid)


# ---------------------------------------------------------------- merged stream
def generate_ops(sc, params: Params | None = None):
    """Yield all ops in nondecreasing time order, up to sc.duration_ns."""
    p = params or Params(sc)
    end = sc.duration_ns
    wl_rng = make_rng(sc.seed, "workload")
    mean_gap = 1e9 / p.rate
    pop = None
    static = []
    if p.profile == "prefill":
        wb = _weight_bytes(p)
        for node in p.nodes:
            for l in range(int(p.model["layers"])):
                static.append((0, "alloc", f"w/{node}/L{l}", wb, node, None))
    elif p.profile == "moe":
        pop = moe_popularity(p.model, np.random.Generator(np.random.PCG64(
            np.random.SeedSequence(sc.seed, spawn_key=(0, 0)))), int(p.model["layers"]))
        esize = p.size(p.model["expert_size_bytes"])
        for node in p.nodes:
            for l in range(len(pop)):
                for e in range(int(p.model["experts"])):
                    static.append((0, "alloc", f"expert/{node}/L{l}/E{e}", esize, node, None))
    yield from static
    maker = {"kv_cache_decode": _kv_decode, "prefill": _prefill, "sparse_attention": _sparse}.get(p.profile)
    heap, seq, idx = [], 0, 0
    arrival = int(math.ceil(wl_rng.exponential(mean_gap)))

    def start(i, t0):
        node = p.nodes[i % len(p.nodes)]
        rng = _req_rng(sc.seed, i)
        return _moe(p, i, node, t0, rng, pop) if p.profile == "moe" else maker(p, i, node, t0, rng)

    while True:
        top = heap[0][0] if heap else None
        if arrival is not None and (top is None or arrival <= top):
            gen = start(idx, arrival)
            idx += 1
            first = next(gen, None)
            if first is not None:
                seq += 1
                heapq.heappush(heap, (first[0], seq, first, gen))
            arrival += int(math.ceil(wl_rng.exponential(mean_gap)))
            if arrival > end:
                arrival = None
        elif heap:
            ts, _, op, gen = heapq.heappop(heap)
            if ts > end:
                continue  # this request is past the horizon
            yield op
            nxt = next(gen, None)
            if nxt is not None:
                seq += 1
                heapq.heappush(heap, (nxt[0], seq, nxt, gen))
        else:
            break
