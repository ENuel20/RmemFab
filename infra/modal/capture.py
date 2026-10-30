"""Capture a real vLLM KV-cache trace on Modal.

The capture records two artifacts:

* ``kv_trace.jsonl``: per-decode-step block-table reads/writes, in the
  RmemFab trace schema (SPECS/trace.schema.json).
* ``allocator_trace.jsonl`` plus ``snapshot.pickle``: the PyTorch CUDA
  allocator history, kept as evidence and for fragmentation analysis.

Example:

    modal run infra/modal/capture.py \
        --model facebook/opt-125m \
        --prompt-tokens 256 \
        --max-tokens 16 \
        --concurrency 1

Llama models are gated. To capture one, create a Modal secret named
``huggingface`` with ``HF_TOKEN`` and add it to the function's ``secrets``.
"""

from __future__ import annotations

import hashlib
import json
import os
import time
from datetime import datetime, timezone
from pathlib import Path

import modal

APP_NAME = "rmemfab-trace-capture"
VOLUME_NAME = "rmemfab-traces"
DATA = Path("/data")

image = (
    modal.Image.debian_slim(python_version="3.10")
    .pip_install(
        "vllm==0.6.3",
        "transformers==4.46.3",
        "tokenizers==0.20.3",
        "huggingface_hub==0.26.2",
    )
    .env(
        {
            "VLLM_ALLOW_DEPRECATED_BLOCK_MANAGER_V1": "1",
            "TOKENIZERS_PARALLELISM": "false",
        }
    )
)

app = modal.App(APP_NAME, image=image)
volume = modal.Volume.from_name(VOLUME_NAME, create_if_missing=True)


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


def _kv_geometry(model_config) -> tuple[int, int, int, int, int]:
    layers = int(model_config.num_hidden_layers)
    heads = int(model_config.num_attention_heads)
    kv_heads = int(getattr(model_config, "num_key_value_heads", heads))
    head_dim = int(model_config.hidden_size) // heads
    dtype_bytes = 2
    bytes_per_token = 2 * layers * kv_heads * head_dim * dtype_bytes
    return layers, heads, kv_heads, head_dim, bytes_per_token


def _prompt_ids(tokenizer, prompt_tokens: int) -> list[int]:
    text = "RmemFab captures real KV-cache behaviour. " * 128
    ids = tokenizer.encode(text, add_special_tokens=False)
    if not ids:
        ids = [tokenizer.eos_token_id or 1]
    while len(ids) < prompt_tokens:
        ids.extend(ids)
    return ids[:prompt_tokens]


@app.function(gpu="A10G", timeout=1800, volumes={str(DATA): volume})
def capture(
    model: str = "facebook/opt-125m",
    prompt_tokens: int = 256,
    max_tokens: int = 16,
    concurrency: int = 1,
    block_size: int = 16,
    seed: int = 7,
) -> str:
    import torch
    import vllm
    from transformers import AutoTokenizer
    from vllm.engine.arg_utils import EngineArgs
    from vllm.engine.llm_engine import LLMEngine
    from vllm.inputs import TokensPrompt
    from vllm.sampling_params import SamplingParams

    run_id = f"{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}-{model.split('/')[-1]}"
    out_dir = DATA / run_id
    out_dir.mkdir(parents=True, exist_ok=True)

    engine_args = EngineArgs(
        model=model,
        tokenizer=model,
        dtype="half",
        max_model_len=prompt_tokens + max_tokens + 16,
        gpu_memory_utilization=0.55,
        enforce_eager=True,
        block_size=block_size,
        swap_space=0,
        disable_log_stats=True,
        seed=seed,
        use_v2_block_manager=False,
    )
    engine = LLMEngine.from_engine_args(engine_args)

    tokenizer = AutoTokenizer.from_pretrained(model)
    prompt_ids = _prompt_ids(tokenizer, prompt_tokens)
    layers, heads, kv_heads, head_dim, bytes_per_token = _kv_geometry(
        engine.model_config.hf_config
    )
    block_bytes = bytes_per_token * block_size

    torch.cuda.memory._record_memory_history(max_entries=200000)

    params = SamplingParams(max_tokens=max_tokens, temperature=0.0, ignore_eos=True)
    tokens_prompt = TokensPrompt(prompt_token_ids=prompt_ids)
    for i in range(concurrency):
        engine.add_request(f"req-{i:03d}", tokens_prompt, params)

    header = {
        "type": "header",
        "trace_version": "0.1",
        "source": f"vllm-{vllm.__version__}-block-table",
        "model": model,
        "runtime": f"vllm {vllm.__version__} / torch {torch.__version__}",
        "batch_size": concurrency,
        "context_tokens": prompt_tokens + max_tokens,
        "dtype": "float16",
        "clock_unit": "ns",
        "created_at": datetime.now(timezone.utc).isoformat(),
        "notes": (
            "Per-step vLLM block-table reads and writes. Page ids are logical "
            "block ids, not physical addresses. Allocator evidence is in "
            "allocator_trace.jsonl and snapshot.pickle."
        ),
    }
    events: list[dict] = []
    previous: dict[int, list[int]] = {}
    known_request_ids: dict[int, str] = {}
    start_ns = time.perf_counter_ns()
    steps = 0
    peak_running = 0

    while engine.has_unfinished_requests():
        engine.step()
        now_ns = time.perf_counter_ns() - start_ns
        scheduler = engine.scheduler[0]
        block_manager = scheduler.block_manager
        current: dict[int, list[int]] = {}
        current_len: dict[int, int] = {}
        request_ids: dict[int, str] = {}

        for group in scheduler.running:
            for seq in group.get_seqs():
                table = [
                    int(getattr(block, "block_number", block))
                    for block in block_manager.block_tables.get(seq.seq_id, [])
                ]
                current[seq.seq_id] = table
                current_len[seq.seq_id] = int(seq.get_len())
                request_ids[seq.seq_id] = group.request_id
                known_request_ids[seq.seq_id] = group.request_id

        peak_running = max(peak_running, len(current))

        for seq_id, table in current.items():
            request_id = request_ids[seq_id]
            old = previous.get(seq_id, [])
            for block_id in table[len(old) :]:
                events.append(
                    {
                        "ts_ns": now_ns,
                        "op": "alloc",
                        "page_id": f"{request_id}:blk{block_id}",
                        "bytes": block_bytes,
                        "request_id": request_id,
                        "tier": "local",
                        "metadata": {"block_id": block_id, "block_size": block_size},
                    }
                )

            seq_len = current_len[seq_id]
            for index, block_id in enumerate(table):
                tokens = min(block_size, max(0, seq_len - index * block_size))
                if tokens == 0:
                    continue
                events.append(
                    {
                        "ts_ns": now_ns + index,
                        "op": "read",
                        "page_id": f"{request_id}:blk{block_id}",
                        "bytes": tokens * bytes_per_token,
                        "request_id": request_id,
                        "tier": "local",
                        "metadata": {
                            "block_id": block_id,
                            "tokens_in_block": tokens,
                            "step": steps,
                        },
                    }
                )

            if table:
                events.append(
                    {
                        "ts_ns": now_ns + len(table),
                        "op": "write",
                        "page_id": f"{request_id}:blk{table[-1]}",
                        "bytes": bytes_per_token,
                        "request_id": request_id,
                        "tier": "local",
                        "metadata": {"block_id": table[-1], "step": steps},
                    }
                )

        for seq_id, table in previous.items():
            if seq_id in current:
                continue
            request_id = known_request_ids.get(seq_id, f"seq-{seq_id}")
            for block_id in table:
                events.append(
                    {
                        "ts_ns": now_ns,
                        "op": "free",
                        "page_id": f"{request_id}:blk{block_id}",
                        "bytes": block_bytes,
                        "request_id": request_id,
                        "tier": "local",
                        "metadata": {"block_id": block_id},
                    }
                )

        previous = current
        steps += 1

    torch.cuda.memory._dump_snapshot(str(out_dir / "snapshot.pickle"))
    snapshot = torch.cuda.memory._snapshot()
    torch.cuda.memory._record_memory_history(enabled=None)

    allocator_events: list[dict] = []
    alloc_actions = 0
    free_actions = 0
    first_us: int | None = None
    for device_trace in snapshot.get("device_traces", []):
        for entry in device_trace:
            action = entry.get("action")
            if action == "alloc":
                op = "alloc"
                alloc_actions += 1
            elif action == "free_completed":
                op = "free"
                free_actions += 1
            else:
                continue
            time_us = int(entry.get("time_us", 0))
            if first_us is None or time_us < first_us:
                first_us = time_us
            addr = int(entry.get("addr", 0))
            allocator_events.append(
                {
                    "ts_ns": max(0, time_us) * 1000,
                    "op": op,
                    "page_id": f"cuda:{addr:x}",
                    "bytes": int(entry.get("size", 0)),
                    "tier": "local",
                    "metadata": {
                        "source": "torch.cuda.memory._snapshot",
                        "action": action,
                        "stream": entry.get("stream"),
                    },
                }
            )
    if first_us is not None:
        for event in allocator_events:
            event["ts_ns"] = max(0, event["ts_ns"] - first_us * 1000)
    allocator_events.sort(key=lambda e: (e["ts_ns"], e["page_id"], e["op"]))

    kv_path = out_dir / "kv_trace.jsonl"
    allocator_path = out_dir / "allocator_trace.jsonl"
    _write_jsonl(kv_path, [header, *events])
    _write_jsonl(
        allocator_path,
        [
            {
                **header,
                "source": f"torch-{torch.__version__}-cuda-allocator",
                "notes": "PyTorch CUDA caching allocator history.",
            },
            *allocator_events,
        ],
    )

    manifest = {
        "trace_version": "0.1",
        "source": "vllm-cuda-snapshot",
        "run_id": run_id,
        "created_at": header["created_at"],
        "model": model,
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
        "steps": steps,
        "peak_running_sequences": peak_running,
        "kv_geometry": {
            "layers": layers,
            "attention_heads": heads,
            "kv_heads": kv_heads,
            "head_dim": head_dim,
            "dtype_bytes": 2,
            "bytes_per_token": bytes_per_token,
        },
        "block_size_tokens": block_size,
        "block_bytes": block_bytes,
        "page_size_bytes": 2097152,
        "page_normalization": {
            "block_bytes": block_bytes,
            "blocks_per_rmemfab_page": 2097152 / block_bytes,
            "note": "RmemFab replay must report this adjustment per A4.4.",
        },
        "counts": {
            "kv_events": len(events),
            "allocator_events": len(allocator_events),
            "allocator_alloc": alloc_actions,
            "allocator_free": free_actions,
        },
        "files": {
            "kv_trace.jsonl": _sha256(kv_path),
            "allocator_trace.jsonl": _sha256(allocator_path),
            "snapshot.pickle": _sha256(out_dir / "snapshot.pickle"),
        },
    }
    manifest_path = out_dir / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
    volume.commit()
    return json.dumps(manifest, indent=2, sort_keys=True)


@app.local_entrypoint()
def main(
    model: str = "facebook/opt-125m",
    prompt_tokens: int = 256,
    max_tokens: int = 16,
    concurrency: int = 1,
    block_size: int = 16,
    seed: int = 7,
):
    print(capture.remote(
        model=model,
        prompt_tokens=prompt_tokens,
        max_tokens=max_tokens,
        concurrency=concurrency,
        block_size=block_size,
        seed=seed,
    ))
