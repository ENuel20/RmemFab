"""Workload geometry: model shape in, page counts out.

This module is the model-agnostic seam. It knows how model descriptions map
to state footprints, and nothing about placement, tiers, timing, or fabric.
The engine calls these pure functions; Phase 2 trace replay replaces the
caller, not the core.

Two input styles are accepted:
- `layer_classes`: explicit per-class geometry. Each class states how many
  layers it holds, how many state bytes one token needs across those layers,
  and an optional attention window. Uniform dense models, sliding-window
  hybrids, and linear/dense hybrids are all just parameter sets here.
- legacy dense fields (`layers`, `kv_heads`, `head_dim`, `dtype_bytes`):
  collapsed to a single full-context class via the standard closed form.
"""
from __future__ import annotations

from dataclasses import dataclass


class GeometryError(Exception):
    def __init__(self, errors):
        self.errors = list(errors)
        super().__init__("; ".join(self.errors))


@dataclass(frozen=True)
class LayerClass:
    name: str
    layers: int
    kv_bytes_per_token: int  # total across this class's layers, per token; 0 = stateless
    window_tokens: int | None  # None = full context; else trailing window scanned per step


def _is_int(x) -> bool:
    return (isinstance(x, int) and not isinstance(x, bool)) or (
        isinstance(x, float) and x.is_integer()
    )


def _num(path: str, v, *, minimum=None, allow_zero=True) -> int | float:
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        raise GeometryError([f"{path}: expected a number, got {v!r}"])
    if minimum is not None and v < minimum:
        raise GeometryError([f"{path}: {v} is below minimum {minimum}"])
    if not allow_zero and v == 0:
        raise GeometryError([f"{path}: must be non-zero"])
    return v


def resolve_layer_classes(model: dict) -> tuple[list[LayerClass], str]:
    """Return (classes, source) where source is 'layer_classes' or 'legacy_dense'."""
    if not isinstance(model, dict):
        raise GeometryError(["workload.model: expected an object"])
    if "layer_classes" in model:
        raw = model["layer_classes"]
        if not isinstance(raw, list) or not raw:
            raise GeometryError(["workload.model.layer_classes: expected a non-empty list"])
        out: list[LayerClass] = []
        for i, c in enumerate(raw):
            p = f"workload.model.layer_classes[{i}]"
            if not isinstance(c, dict):
                raise GeometryError([f"{p}: expected an object"])
            name = c.get("name", f"class-{i}")
            if not isinstance(name, str) or not name:
                raise GeometryError([f"{p}.name: expected a non-empty string"])
            layers = c.get("layers")
            if not _is_int(layers) or int(layers) < 1:
                raise GeometryError([f"{p}.layers: expected an integer >= 1"])
            kv = _num(f"{p}.kv_bytes_per_token", c.get("kv_bytes_per_token"), minimum=0)
            window = c.get("window_tokens")
            if window is not None and (not _is_int(window) or int(window) < 1):
                raise GeometryError([f"{p}.window_tokens: expected an integer >= 1 or null"])
            out.append(LayerClass(name, int(layers), int(kv),
                                  None if window is None else int(window)))
        if len({c.name for c in out}) != len(out):
            raise GeometryError(["workload.model.layer_classes: class names must be unique"])
        return out, "layer_classes"
    missing = [k for k in ("layers", "kv_heads", "head_dim", "dtype_bytes") if k not in model]
    if missing:
        raise GeometryError([f"workload.model.{k}: required (or provide layer_classes)" for k in missing])
    for k in ("layers", "kv_heads", "head_dim"):
        if not _is_int(model[k]) or int(model[k]) < 1:
            raise GeometryError([f"workload.model.{k}: expected an integer >= 1"])
    dt = _num("workload.model.dtype_bytes", model["dtype_bytes"], minimum=0, allow_zero=False)
    exact = 2 * int(model["layers"]) * int(model["kv_heads"]) * int(model["head_dim"]) * dt
    kv = int(round(exact))
    if abs(exact - kv) > 1e-6:
        raise GeometryError(["workload.model: kv bytes per token is not integral"])
    return [LayerClass("dense", int(model["layers"]), kv, None)], "legacy_dense"


def pages_for(tokens: int, kv_bytes_per_token: int, page_size: int) -> int:
    if tokens <= 0 or kv_bytes_per_token <= 0:
        return 0
    return -(-(int(tokens) * int(kv_bytes_per_token)) // int(page_size))


def read_span(total_tokens: int, klass: LayerClass, page_size: int) -> tuple[int, int]:
    """[lo, hi) page indices scanned by one decode step for this class."""
    hi = pages_for(total_tokens, klass.kv_bytes_per_token, page_size)
    if hi == 0:
        return (0, 0)
    if klass.window_tokens is None:
        return (0, hi)
    lo = pages_for(max(0, total_tokens - klass.window_tokens), klass.kv_bytes_per_token, page_size)
    return (min(lo, hi), hi)
