"""Capture a real Muse Glimmer workload on Modal and derive a KV trace.

Why this file exists
--------------------
Muse Glimmer requires vLLM 0.28.0+. That version preallocates its KV pool, so
the CUDA allocator snapshot does not expose per-block KV activity. This capture
therefore records:

* the real request outcomes and timings from vLLM,
* the real PyTorch CUDA allocator history during generation,
* a derived KV page trace built from the measured token counts and Muse
  Glimmer's published layer geometry.

The derived trace is labeled as such. It is not a block-table trace.

Example:

    modal run infra/modal/capture_muse_glimmer.py \
        --prompt-tokens 8192 --max-tokens 32 --concurrency 8
"""

from __future__ import annotations

import hashlib
import json
import math
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

import modal

APP_NAME = "rmemfab-muse-glimmer-capture"
TRACE_VOLUME = "rmemfab-traces"
HF_VOLUME = "rmemfab-hf-cache"
DATA = Path("/data")

image = (
    modal.Image.from_registry("vllm/vllm-openai:muse-glimmer", add_python="3.12")
    .entrypoint([])
    .env(
        {
            "HF_HOME": "/root/.cache/huggingface",
            "TOKENIZERS_PARALLELISM": "false",
            "PYTHONPATH": "/usr/local/lib/python3.12/dist-packages",
            # This job sends only its own trusted callback to its own vLLM worker
            # so we can query CUDA allocator peaks from the process that owns it.
            "VLLM_ALLOW_INSECURE_SERIALIZATION": "1",
        }
    )
)

app = modal.App(APP_NAME, image=image)
trace_volume = modal.Volume.from_name(TRACE_VOLUME, create_if_missing=True)
hf_volume = modal.Volume.from_name(HF_VOLUME, create_if_missing=True)

MODEL = "meta-models/Muse-Glimmer-30B"
PAGE_SIZE_BYTES = 2 * 1024 * 1024


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def _write_jsonl(path: Path, rows: list[dict]) -> None:
    with path.open("w", encoding="utf-8") as f:
        for row in rows:
            f.write(json.dumps(row, sort_keys=True, separators=(",", ":")))
            f.write("\n")


def _tokenizer_ids(tokenizer, count: int) -> list[int]:
    text = (
        "RmemFab measures real KV-cache behavior for Muse Glimmer on an A100. "
        "The workload is deliberately long enough to create memory pressure. "
    )
    ids = tokenizer.encode(text * 512, add_special_tokens=False)
    if not ids:
        ids = [tokenizer.eos_token_id or 1]
    while len(ids) < count:
        ids.extend(ids)
    return ids[:count]


def _metrics_dict(output) -> dict:
    metrics = getattr(output, "metrics", None)
    if metrics is None:
        return {}
    result = {}
    for name in (
        "arrival_time",
        "first_scheduled_time",
        "first_token_time",
        "finished_time",
        "queued_time",
        "scheduled_time",
        "prefill_time",
        "decode_time",
        "inference_time",
    ):
        value = getattr(metrics, name, None)
        if value is not None:
            result[name] = float(value)
    return result


def _reset_worker_cuda_peaks(model) -> bool:
    import torch

    torch.cuda.reset_peak_memory_stats(0)
    return True


def _worker_cuda_memory_stats(model) -> dict:
    import torch

    stats = torch.cuda.memory_stats(0)
    return {
        "allocated_current_bytes": int(stats.get("allocated_bytes.all.current", 0)),
        "allocated_peak_bytes": int(stats.get("allocated_bytes.all.peak", 0)),
        "reserved_current_bytes": int(stats.get("reserved_bytes.all.current", 0)),
        "reserved_peak_bytes": int(stats.get("reserved_bytes.all.peak", 0)),
        "source": "torch.cuda.memory_stats inside vLLM model worker",
    }


def _allocator_trace(snapshot: dict) -> list[dict]:
    events: list[dict] = []
    first_us: int | None = None
    for device_trace in snapshot.get("device_traces", []):
        for entry in device_trace:
            action = entry.get("action")
            if action == "alloc":
                op = "alloc"
            elif action == "free_completed":
                op = "free"
            else:
                continue
            time_us = int(entry.get("time_us", 0))
            if first_us is None or time_us < first_us:
                first_us = time_us
            events.append(
                {
                    "ts_ns": max(0, time_us) * 1000,
                    "op": op,
                    "page_id": f"cuda:{int(entry.get('addr', 0)):x}",
                    "bytes": max(1, int(entry.get("size", 0))),
                    "tier": "local",
                    "metadata": {
                        "source": "torch.cuda.memory._snapshot",
                        "action": action,
                        "stream": entry.get("stream"),
                    },
                }
            )
    if first_us is not None:
        for event in events:
            event["ts_ns"] = max(0, event["ts_ns"] - first_us * 1000)
    events.sort(key=lambda e: (e["ts_ns"], e["page_id"], e["op"]))
    return events


def _derive_kv_trace(
    requests: list[dict],
    text_config: dict,
    page_size_bytes: int,
    trace_version: str,
    created_at: str,
) -> list[dict]:
    layers = int(text_config["num_hidden_layers"])
    kv_heads = int(text_config["num_key_value_heads"])
    head_dim = int(text_config["head_dim"])
    dtype_bytes = 2
    layer_types = text_config.get("layer_types") or ["full_attention"] * layers
    sliding_window = int(text_config.get("sliding_window") or 2048)

    bytes_per_token_per_layer = 2 * kv_heads * head_dim * dtype_bytes
    tokens_per_page_per_layer = max(1, page_size_bytes // bytes_per_token_per_layer)

    header = {
        "type": "header",
        "trace_version": trace_version,
        "source": "muse-glimmer-derived-kv",
        "model": MODEL,
        "runtime": "vLLM 0.28+ / Muse Glimmer BF16",
        "batch_size": len(requests),
        "context_tokens": max(
            (r["prompt_tokens"] + r["generated_tokens"] for r in requests),
            default=0,
        ),
        "dtype": "bfloat16",
        "clock_unit": "ns",
        "created_at": created_at,
        "notes": (
            "KV page accesses are derived from measured request token counts and "
            "Muse Glimmer layer geometry. Full-attention layers scan the full "
            "context; sliding-window layers scan only the last sliding_window "
            "tokens. This is not a vLLM block-table trace."
        ),
    }

    events: list[dict] = []
    for req in requests:
        rid = req["request_id"]
        prompt = int(req["prompt_tokens"])
        generated = int(req["generated_tokens"])
        start_ns = int(req.get("start_ns", 0))
        first_ns = int(req.get("first_token_ns", start_ns))
        end_ns = int(req.get("finished_ns", first_ns))
        step_ns = max(1, (end_ns - first_ns) // max(1, generated))

        full_layers = [
            i for i, kind in enumerate(layer_types) if kind == "full_attention"
        ]
        sliding_layers = [
            i for i, kind in enumerate(layer_types) if kind != "full_attention"
        ]

        def page_id(layer: int, page_index: int) -> str:
            return f"{rid}:L{layer}:P{page_index}"

        def page_bytes(tokens: int) -> int:
            return max(1, min(page_size_bytes, tokens * bytes_per_token_per_layer))

        allocated: set[str] = set()

        def alloc(pid: str, ts: int, nbytes: int, layer: int) -> None:
            if pid in allocated:
                return
            allocated.add(pid)
            events.append(
                {
                    "ts_ns": ts,
                    "op": "alloc",
                    "page_id": pid,
                    "bytes": nbytes,
                    "request_id": rid,
                    "tier": "local",
                    "metadata": {
                        "layer": layer,
                        "derived": True,
                        "bytes_per_token": bytes_per_token_per_layer,
                    },
                }
            )

        for step in range(generated + 1):
            context = prompt + step
            ts = first_ns + step * step_ns

            for layer in full_layers:
                pages = max(1, math.ceil(context / tokens_per_page_per_layer))
                for page_index in range(pages):
                    tokens_in_page = min(
                        tokens_per_page_per_layer,
                        context - page_index * tokens_per_page_per_layer,
                    )
                    if tokens_in_page <= 0:
                        continue
                    pid = page_id(layer, page_index)
                    nbytes = page_bytes(tokens_in_page)
                    alloc(pid, ts, nbytes, layer)
                    events.append(
                        {
                            "ts_ns": ts,
                            "op": "read",
                            "page_id": pid,
                            "bytes": nbytes,
                            "request_id": rid,
                            "tier": "local",
                            "metadata": {
                                "layer": layer,
                                "step": step,
                                "kind": "full_attention",
                                "derived": True,
                            },
                        }
                    )

            for layer in sliding_layers:
                window = min(context, sliding_window)
                pages = max(1, math.ceil(window / tokens_per_page_per_layer))
                for page_index in range(pages):
                    tokens_in_page = min(
                        tokens_per_page_per_layer,
                        window - page_index * tokens_per_page_per_layer,
                    )
                    if tokens_in_page <= 0:
                        continue
                    pid = page_id(layer, page_index)
                    nbytes = page_bytes(tokens_in_page)
                    alloc(pid, ts, nbytes, layer)
                    events.append(
                        {
                            "ts_ns": ts,
                            "op": "read",
                            "page_id": pid,
                            "bytes": nbytes,
                            "request_id": rid,
                            "tier": "local",
                            "metadata": {
                                "layer": layer,
                                "step": step,
                                "kind": "sliding_attention",
                                "derived": True,
                            },
                        }
                    )

            if step < generated:
                new_context = prompt + step + 1
                for layer in full_layers:
                    page_index = max(0, (new_context - 1) // tokens_per_page_per_layer)
                    pid = page_id(layer, page_index)
                    events.append(
                        {
                            "ts_ns": ts,
                            "op": "write",
                            "page_id": pid,
                            "bytes": bytes_per_token_per_layer,
                            "request_id": rid,
                            "tier": "local",
                            "metadata": {
                                "layer": layer,
                                "step": step,
                                "kind": "full_attention",
                                "derived": True,
                            },
                        }
                    )
                for layer in sliding_layers:
                    page_index = max(0, (min(new_context, sliding_window) - 1) // tokens_per_page_per_layer)
                    pid = page_id(layer, page_index)
                    events.append(
                        {
                            "ts_ns": ts,
                            "op": "write",
                            "page_id": pid,
                            "bytes": bytes_per_token_per_layer,
                            "request_id": rid,
                            "tier": "local",
                            "metadata": {
                                "layer": layer,
                                "step": step,
                                "kind": "sliding_attention",
                                "derived": True,
                            },
                        }
                    )

        for pid in sorted(allocated):
            layer = int(pid.split(":L")[1].split(":")[0])
            nbytes = page_size_bytes
            for event in reversed(events):
                if event["page_id"] == pid and event["op"] in ("read", "write"):
                    nbytes = event["bytes"]
                    break
            events.append(
                {
                    "ts_ns": end_ns,
                    "op": "free",
                    "page_id": pid,
                    "bytes": nbytes,
                    "request_id": rid,
                    "tier": "local",
                    "metadata": {"layer": layer, "derived": True},
                }
            )

    events.sort(key=lambda e: (e["ts_ns"], e["page_id"], e["op"]))
    return [header, *events]


@app.function(
    gpu="A100-80GB",
    timeout=7200,
    volumes={str(DATA): trace_volume, "/root/.cache/huggingface": hf_volume},
)
def capture(
    prompt_tokens: int = 8192,
    max_tokens: int = 32,
    concurrency: int = 8,
    seed: int = 7,
) -> str:
    import torch
    import vllm
    from vllm import LLM, SamplingParams
    from vllm.sampling_params import RequestOutputKind

    run_id = f"{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}-muse-glimmer"
    out_dir = DATA / run_id
    out_dir.mkdir(parents=True, exist_ok=True)

    started_wall = time.time()
    llm = LLM(
        model=MODEL,
        dtype="bfloat16",
        max_model_len=max(prompt_tokens + max_tokens + 256, 2048),
        max_num_seqs=max(1, concurrency),
        gpu_memory_utilization=0.90,
        enforce_eager=True,
        trust_remote_code=False,
        disable_log_stats=False,
    )
    tokenizer = llm.get_tokenizer()
    prompt_ids = _tokenizer_ids(tokenizer, prompt_tokens)
    sampling = SamplingParams(
        max_tokens=max_tokens,
        temperature=1.0,
        top_p=0.95,
        top_k=64,
        seed=seed,
        ignore_eos=True,
        output_kind=RequestOutputKind.DELTA,
    )

    torch.cuda.memory._record_memory_history(max_entries=400000)
    llm.apply_model(_reset_worker_cuda_peaks)
    memory_samples: list[tuple[float, int, int]] = []
    stop_memory_sampling = threading.Event()

    def sample_gpu_memory() -> None:
        while not stop_memory_sampling.is_set():
            free_bytes, total_bytes = torch.cuda.mem_get_info(0)
            memory_samples.append((time.time(), int(free_bytes), int(total_bytes)))
            stop_memory_sampling.wait(0.05)

    free_before, total_bytes = torch.cuda.mem_get_info(0)
    sampler = threading.Thread(target=sample_gpu_memory, daemon=True)
    sampler.start()
    generation_start = time.time()
    request_state: dict[str, dict] = {}
    for index in range(concurrency):
        request_id = f"req-{index:03d}"
        arrival = time.time()
        request_state[request_id] = {
            "request_id": request_id,
            "prompt_tokens": len(prompt_ids),
            "generated_tokens": 0,
            "arrival_s": arrival,
            "first_token_s": None,
            "finished_s": None,
            "token_ids": [],
        }
        llm.llm_engine.add_request(
            request_id, {"prompt_token_ids": prompt_ids}, sampling
        )
    while llm.llm_engine.has_unfinished_requests():
        for output in llm.llm_engine.step():
            now = time.time()
            state = request_state[str(output.request_id)]
            token_ids = output.outputs[0].token_ids if output.outputs else []
            if token_ids and state["first_token_s"] is None:
                state["first_token_s"] = now
            state["token_ids"].extend(int(token) for token in token_ids)
            state["generated_tokens"] = len(state["token_ids"])
            if output.finished:
                state["finished_s"] = now
    generation_end = time.time()
    worker_cuda_memory = llm.apply_model(_worker_cuda_memory_stats)
    stop_memory_sampling.set()
    sampler.join()
    free_after, _ = torch.cuda.mem_get_info(0)
    memory_samples.append((generation_end, int(free_after), int(total_bytes)))
    min_free_bytes = min((sample[1] for sample in memory_samples), default=int(free_after))
    peak_memory = {
        "gpu_used_bytes_high_water": int(total_bytes - min_free_bytes),
        "gpu_free_bytes_before_generation": int(free_before),
        "gpu_free_bytes_after_generation": int(free_after),
        "gpu_used_bytes_generation_delta_high_water": max(0, int(free_before - min_free_bytes)),
        "total_bytes": int(total_bytes),
        "sample_interval_ms": 50,
        "sample_count": len(memory_samples),
        "source": "torch.cuda.mem_get_info sampled during generation",
        "scope": "whole GPU; includes model weights, vLLM KV pool, and any other GPU processes",
    }
    torch.cuda.memory._dump_snapshot(str(out_dir / "snapshot.pickle"))
    snapshot = torch.cuda.memory._snapshot()
    torch.cuda.memory._record_memory_history(enabled=None)

    base_wall = min((r["arrival_s"] for r in request_state.values()), default=generation_start)
    requests: list[dict] = []
    for state in request_state.values():
        arrival = float(state["arrival_s"])
        first = state["first_token_s"]
        finished = float(state["finished_s"] or generation_end)
        requests.append({
            "request_id": state["request_id"],
            "prompt_tokens": state["prompt_tokens"],
            "generated_tokens": state["generated_tokens"],
            "arrival_s": arrival,
            "first_token_s": first,
            "ttft_s": max(0.0, float(first) - arrival) if first is not None else None,
            "finished_s": finished,
            "start_ns": int((arrival - base_wall) * 1e9),
            "first_token_ns": int(((float(first) if first is not None else generation_start) - base_wall) * 1e9),
            "finished_ns": int((finished - base_wall) * 1e9),
            "metrics": {"ttft_s": max(0.0, float(first) - arrival)} if first is not None else {},
        })
    requests.sort(key=lambda r: (r["start_ns"], r["request_id"]))

    raw_text_config = llm.model_config.hf_config.text_config
    if hasattr(raw_text_config, "to_dict"):
        text_config = raw_text_config.to_dict()
    else:
        text_config = dict(raw_text_config)
    created_at = datetime.now(timezone.utc).isoformat()
    trace_version = "0.1"
    kv_rows = _derive_kv_trace(
        requests, text_config, PAGE_SIZE_BYTES, trace_version, created_at
    )
    allocator_rows = [
        {
            "type": "header",
            "trace_version": trace_version,
            "source": f"torch-{torch.__version__}-cuda-allocator",
            "model": MODEL,
            "runtime": f"vLLM {vllm.__version__} / torch {torch.__version__}",
            "batch_size": concurrency,
            "context_tokens": prompt_tokens + max_tokens,
            "dtype": "bfloat16",
            "clock_unit": "ns",
            "created_at": created_at,
            "notes": "PyTorch CUDA caching allocator history during generation.",
        },
        *_allocator_trace(snapshot),
    ]

    requests_path = out_dir / "requests.jsonl"
    kv_path = out_dir / "kv_trace.jsonl"
    allocator_path = out_dir / "allocator_trace.jsonl"
    _write_jsonl(requests_path, requests)
    _write_jsonl(kv_path, kv_rows)
    _write_jsonl(allocator_path, allocator_rows)

    bytes_per_token = (
        2
        * int(text_config["num_hidden_layers"])
        * int(text_config["num_key_value_heads"])
        * int(text_config["head_dim"])
        * 2
    )
    manifest = {
        "trace_version": trace_version,
        "source": "muse-glimmer-derived-kv",
        "run_id": run_id,
        "created_at": created_at,
        "model": MODEL,
        "runtime": {
            "vllm": str(vllm.__version__),
            "torch": str(torch.__version__),
            "cuda": str(torch.version.cuda),
        },
        "gpu": str(torch.cuda.get_device_name(0)),
        "seed": seed,
        "concurrency": concurrency,
        "prompt_tokens": prompt_tokens,
        "generated_tokens": max_tokens,
        "generation_wall_seconds": generation_end - generation_start,
        "cuda_memory": peak_memory,
        "worker_cuda_memory": worker_cuda_memory,
        "kv_geometry": {
            "layers": int(text_config["num_hidden_layers"]),
            "attention_heads": int(text_config["num_attention_heads"]),
            "kv_heads": int(text_config["num_key_value_heads"]),
            "head_dim": int(text_config["head_dim"]),
            "dtype_bytes": 2,
            "bytes_per_token_all_layers": bytes_per_token,
            "full_attention_layers": sum(
                1 for x in text_config["layer_types"] if x == "full_attention"
            ),
            "sliding_attention_layers": sum(
                1 for x in text_config["layer_types"] if x != "full_attention"
            ),
            "sliding_window_tokens": int(text_config["sliding_window"]),
        },
        "page_size_bytes": PAGE_SIZE_BYTES,
        "page_normalization": {
            "note": "The derived trace already uses RmemFab page granularity.",
        },
        "counts": {
            "requests": len(requests),
            "kv_events": len(kv_rows) - 1,
            "allocator_events": len(allocator_rows) - 1,
        },
        "files": {
            "kv_trace.jsonl": _sha256(kv_path),
            "allocator_trace.jsonl": _sha256(allocator_path),
            "requests.jsonl": _sha256(requests_path),
            "snapshot.pickle": _sha256(out_dir / "snapshot.pickle"),
        },
        "notes": (
            "Measured Muse Glimmer requests on a Modal A100-80GB. KV accesses are "
            "derived from real token counts and the model's published layer "
            "geometry; they are not a vLLM block-table trace."
        ),
    }
    (out_dir / "manifest.json").write_text(
        json.dumps(manifest, indent=2, sort_keys=True) + "\n"
    )
    trace_volume.commit()
    return json.dumps(manifest, indent=2, sort_keys=True)


@app.local_entrypoint()
def main(
    prompt_tokens: int = 8192,
    max_tokens: int = 32,
    concurrency: int = 8,
    seed: int = 7,
):
    print(
        capture.remote(
            prompt_tokens=prompt_tokens,
            max_tokens=max_tokens,
            concurrency=concurrency,
            seed=seed,
        )
    )
