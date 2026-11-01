"""Seeded, independent random streams (determinism contract).

Each stochastic subsystem draws from its own stream so that adding a new
consumer (faults, fabric noise) cannot shift another subsystem's draws.
Stream seeds are recorded in the run manifest.
"""
from __future__ import annotations

import numpy as np

STREAMS = {"workload": 0, "policy": 1, "faults": 2, "fabric": 3}


def _seq(seed: int, name: str) -> np.random.SeedSequence:
    return np.random.SeedSequence(int(seed), spawn_key=(STREAMS[name],))


def make_rng(seed: int, name: str) -> np.random.Generator:
    return np.random.Generator(np.random.PCG64(_seq(seed, name)))


def stream_seeds(seed: int) -> dict:
    return {
        name: [int(x) for x in _seq(seed, name).generate_state(2, dtype=np.uint64)]
        for name in STREAMS
    }
