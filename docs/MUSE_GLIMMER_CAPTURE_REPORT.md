# Capturing and stress-testing Muse Glimmer for RmemFab

**Technical report and experiment record**
**Project:** RmemFab
**Capture date:** 29–30 October 2026 (UTC)
**Status:** A Muse Glimmer baseline trace was captured and checked; a concurrency ramp from 1 through 128 requests completed without OOM. The data show variable TTFT, but do not establish a stable latency cliff or an OOM boundary.

> This report combines checked-in source and artifacts with the OpenCode/DeepSeek troubleshooting history preserved in the project notes. That history is reconstructed as a technical sequence, not quoted as a verbatim transcript. Measurements below are distinguished from modeled/derived trace events.

## 1. Project question

RmemFab is a KV-cache tiering simulator and explorer being prepared for the [Meta AI Developer Hackathon](https://cerebralvalley.ai/e/meta-ai-developer-hackathon/details). The planned workflow is to replay an LLM workload trace and compare local-only, remote-swap, and hot/cold policies. The intended outputs include KV traffic, latency percentiles, stalls, and policy trade-offs.

The original capture used `facebook/opt-125m`. It remains useful as a pipeline fixture, but the hackathon work needed a trace from an eligible Meta model. The immediate experiment therefore moved to `meta-models/Muse-Glimmer-30B`, running on a Modal A100-80GB. The official [Muse Glimmer model card](https://huggingface.co/meta-models/Muse-Glimmer-30B) describes the BF16 model artifact used here.

The experiment asked two narrower questions:

1. Can the Modal/vLLM setup complete a real 8,192-token Muse Glimmer request batch and produce a reproducible RmemFab trace bundle?
2. As the number of submitted requests rises, what happens to request TTFT and memory measurements, and does the serving job fail with OOM?

It did **not** measure the performance of RmemFab’s tiering policies. The ramp describes this serving configuration and workload only.

## 2. What existed before the Glimmer capture

The first capture pipeline was built around OPT-125m:

- [`infra/modal/capture.py`](../infra/modal/capture.py) ran vLLM on Modal.
- [`tools/cuda_snapshot_to_trace.py`](../tools/cuda_snapshot_to_trace.py) converted PyTorch CUDA allocator snapshot events to the RmemFab trace representation.
- [`SPECS/trace.schema.json`](../SPECS/trace.schema.json) defines the trace event contract.
- [`examples/traces/20261029T202303Z-opt-125m/`](../examples/traces/20261029T202303Z-opt-125m/) contains the OPT example.
- [`docs/ACCEPTANCE.md`](ACCEPTANCE.md) records acceptance requirements and measured-trace evidence.

The OPT run used 512 prompt tokens, 32 generated tokens, concurrency 4, an A10 GPU, and torch `2.4.0+cu121`. Its manifest reports 4,540 KV events (4,541 JSONL lines including the header) and 18,406 allocator events (18,407 lines including the header). The KV trace SHA-256 is `6b24f887f28524bce3734a33b27af60918786669a0281601e24c7a1880a35eca`. This is an internal fixture, not the Muse Glimmer submission trace.

## 3. Why Glimmer required a different capture path

The original OPT approach inferred KV activity from PyTorch allocator allocation/free history. That works when the allocator exposes the relevant allocation lifecycle. In this Glimmer/vLLM run, vLLM reserves a KV-cache pool during engine initialization. During generation the pool is reused, so the PyTorch event history does not show per-request KV pages being allocated and freed. The Glimmer baseline consequently has **zero allocator alloc/free events** even though generation uses KV cache.

The report therefore preserves two distinct data classes:

1. **Measured request and device data:** generated token counts, host-clock arrival/first-token/finish times, PyTorch worker allocator counters, device-wide free-memory samples, and runtime metadata.
2. **Derived KV page events:** page reads, writes, allocation, and free events reconstructed from the measured token counts and Glimmer’s model geometry.

Derived KV records use the source label `muse-glimmer-derived-kv`. They are useful for replaying a page-shaped access workload, but are **not** vLLM block-table observations. In particular, they do not prove which physical vLLM cache blocks were touched at each step.

### 3.1 Geometry and page arithmetic

The successful baseline manifest records:

| Parameter | Captured value |
|---|---:|
| Transformer text layers | 52 |
| Attention heads | 32 |
| KV heads | 2 |
| Head dimension | 128 |
| KV dtype | BF16, 2 bytes per scalar |
| Full-attention layers | 13 |
| Sliding-attention layers | 39 |
| Sliding window | 2,048 tokens |
| RmemFab page size | 2 MiB (2,097,152 bytes) |

For one layer and one token, key and value storage is estimated as:

```text
bytes_per_token_per_layer
  = 2 (K and V) × 2 KV heads × 128 head dimensions × 2 bytes
  = 1,024 bytes

tokens_per_2_MiB_page_per_layer
  = 2,097,152 / 1,024
  = 2,048 tokens
```

The manifest’s all-layer figure is `52 × 1,024 = 53,248` bytes per token. For every request, the derivation scans all context pages for full-attention layers and the last 2,048 tokens for sliding-attention layers. It records writes during generation and frees the derived pages at request completion. The generator caps individual logical page byte counts at the configured 2 MiB page size and labels these operations `derived: true`.

At an 8,192-token prompt plus up to 32 generated tokens, each request crosses from four to five 2,048-token pages in its full-attention layers. The current derivation thus records 104 logical page IDs per request (13 full-attention layers × 5 pages, plus 39 sliding-attention layers × 1 page). The stress CSV defines `derived_kv_page_bytes` as page count × 2 MiB, or 208 MiB per request. This is **nominal page capacity summed over a request lifetime**: individual trace events record bytes based on the token count represented at that event, so the byte-field sum need not equal page count × page size. Neither number is a statement that every request simultaneously occupies an additional 208 MiB of vLLM’s physical KV pool. Across 128 requests, the CSV’s nominal page-capacity sum is 26,624 MiB (26 GiB); this should not be read as the pool’s simultaneous physical occupancy.

## 4. Modal image troubleshooting (OpenCode / DeepSeek session history)

The OpenCode troubleshooting sequence resolved a container-runtime mismatch before the model could start. The recorded failures and fixes were:

1. **Use the bare `vllm/vllm-openai:muse-glimmer` image.** Modal could not determine the Python version needed for its function runtime.
2. **Try `.add_python("3.12")` as an image method.** The installed Modal SDK rejected this with `AttributeError: 'Image' object has no attribute 'add_python'`. With the SDK in use (Modal 1.6.3), `add_python="3.12"` belongs on the `Image.from_registry(...)` constructor.
3. **Keep the image’s inherited `vllm serve` entrypoint.** Modal’s function runner arguments were passed to the vLLM CLI, which rejected `-u -R --check-hash-based-pycs never -m modal._container_entrypoint`.
4. **Override with `.entrypoint(["python3"])`.** This still interacted badly with the base image’s command and working directory: Python tried to open `/vllm-workspace/python` as a script.
5. **Clear the inherited entrypoint with `.entrypoint([])`.** This let Modal invoke its Python function runner directly.
6. **Resolve `ModuleNotFoundError: No module named 'torch'`.** A CPU-only image probe showed that Modal’s injected Python was `/usr/local/bin/python` 3.12.1 and searched `/usr/local/lib/python3.12/site-packages`, while the vLLM image packages—including `torch` and `vllm`—were installed under `/usr/local/lib/python3.12/dist-packages`. Adding that directory to `PYTHONPATH` fixed the import path.
7. **Resume rather than redownload model weights.** The first launch reached vLLM initialization but was aborted before producing traces. The Hugging Face volume contained a partial download (approximately 39.9 GB at that point: a roughly 30.26 GB incomplete blob and a 9.60 GB complete blob). The volume was retained for the next attempt.

Modal’s [existing-image guide](https://modal.com/docs/guide/existing-images) documents `add_python` for registry images and explains Python and entrypoint compatibility. The working image setup in the current script is:

```python
image = (
    modal.Image.from_registry("vllm/vllm-openai:muse-glimmer", add_python="3.12")
    .entrypoint([])
    .env({
        "HF_HOME": "/root/.cache/huggingface",
        "TOKENIZERS_PARALLELISM": "false",
        "PYTHONPATH": "/usr/local/lib/python3.12/dist-packages",
        "VLLM_ALLOW_INSECURE_SERIALIZATION": "1",
    })
)
```

The worker-side allocator query is sent as a Python callback to the vLLM model worker. The capture sets `VLLM_ALLOW_INSECURE_SERIALIZATION=1` so that this trusted local callback can be serialized through the worker interface. The run log reported that insecure pickle serialization was allowed. This should remain limited to the controlled capture job and trusted code; do not carry this setting into a service that accepts callbacks or payloads from untrusted users.

## 5. Capture implementation and baseline

The current capture implementation is [`infra/modal/capture_muse_glimmer.py`](../infra/modal/capture_muse_glimmer.py). It attaches an A100-80GB, uses the named Modal volumes `rmemfab-traces` and `rmemfab-hf-cache`, loads `meta-models/Muse-Glimmer-30B` in BF16, and configures `max_model_len=prompt_tokens + max_tokens + 256` (8,480 for the baseline), `gpu_memory_utilization=0.90`, and eager execution. The prompt is created once from a repeated RmemFab description, tokenized to exactly 8,192 token IDs, and reused for each request in the batch. Requests are enqueued in a loop and timestamped one by one, so arrivals are close together but not synchronized to one identical timestamp. Each request generates up to 32 tokens with seed 7, temperature 1.0, top-p 0.95, top-k 64, and EOS ignored.

### 5.1 Why the first TTFT attempt was insufficient

The earlier implementation relied on the vLLM `RequestOutput.metrics` fields. In this offline execution path, per-request first-token timing was unavailable in the returned objects, so it could not support an honest TTFT chart. The capture was changed to use the engine’s lower-level request/step API: it records host time when each request is enqueued, calls `llm.llm_engine.step()` until all requests finish, and records the first step output containing a token. It then calculates `ttft_s = first_token_s - arrival_s` per request.

This is a wall-clock TTFT measured by the capture process around engine enqueue and step calls. It is not a server-side Prometheus histogram, and includes any queueing after enqueue. vLLM’s published [metrics definitions](https://github.com/vllm-project/vllm/blob/main/docs/design/metrics.md) distinguish TTFT from queue, prefill, and decode metrics; the current artifact directly measures only TTFT with this engine loop.

### 5.2 Two memory measurements with different scopes

The capture records both:

- **Worker PyTorch allocator peaks:** `torch.cuda.reset_peak_memory_stats(0)` is called in the model worker after initialization; after generation, `torch.cuda.memory_stats(0)` returns allocated/reserved current and peak byte counters. This is allocator-specific, but its peak is measured after initialization reset and includes the post-reset baseline from persistent allocations. It is not a pure “generation delta” counter.
- **Device-wide memory high-water:** a 50 ms sampling thread calls `torch.cuda.mem_get_info(0)`. The peak used bytes and delta from pre-generation free memory include the model, vLLM’s preallocated KV pool, and any other process using the GPU. This is not allocator-specific and can miss peaks shorter than the sampling interval.

PyTorch’s [CUDA memory usage documentation](https://docs.pytorch.org/docs/stable/torch_cuda_memory.html) explains the difference between PyTorch allocator snapshots and memory allocated directly outside that allocator. The current script also writes `snapshot.pickle`, but the Glimmer allocator event list in the baseline is empty for alloc/free operations. The baseline manifest reports 160 device-memory samples, 1,883,242,496 bytes of device-wide generation delta high-water, and zero allocator events.

### 5.3 Baseline evidence

The baseline is `20261030T000445Z-muse-glimmer`, captured on an NVIDIA A100-SXM4-80GB. Its committed evidence copy is [`examples/traces/20261030T000445Z-muse-glimmer-derived/kv_trace.jsonl`](../examples/traces/20261030T000445Z-muse-glimmer-derived/kv_trace.jsonl), with [`manifest.json`](../examples/traces/20261030T000445Z-muse-glimmer-derived/manifest.json).

| Baseline field | Value |
|---|---:|
| Requests / concurrency | 8 |
| Prompt / generated tokens | 8,192 / 32 |
| Generation wall time | 8.107 s |
| KV JSONL rows | 42,329 total (1 header + 42,328 events) |
| Allocator JSONL events | 0 |
| KV trace SHA-256 | `d340f5f352c1a9e32289201c50230ffe394e7e6b178d9b535638c360970252ea` |
| GPU-wide generation delta high-water | 1,883,242,496 bytes |

The capture wrote `requests.jsonl`, `kv_trace.jsonl`, `allocator_trace.jsonl`, `snapshot.pickle`, and `manifest.json` on the Modal volume, then committed the volume. The repository evidence copy contains the KV trace and manifest; the manifest records hashes for all five outputs from the Modal run, while the request log, allocator event log, and snapshot remain on the Modal volume.

The current baseline hash can be reproduced locally with:

```bash
sha256sum examples/traces/20261030T000445Z-muse-glimmer-derived/kv_trace.jsonl
wc -l examples/traces/20261030T000445Z-muse-glimmer-derived/kv_trace.jsonl
```

## 6. Stress ramp: request counts 1, 4, 8, 16, 32, 64, 128

After the baseline trace was available, the ramp used the same 8,192-token prompt, 32-token maximum output, BF16 model, A100-80GB class, and capture logic. One capture was run for each concurrency setting. The committed summary is [`examples/experiments/muse-glimmer-stress/summary.md`](../examples/experiments/muse-glimmer-stress/summary.md), the underlying table is [`summary.csv`](../examples/experiments/muse-glimmer-stress/summary.csv), and the per-setting manifests are in [`manifests/`](../examples/experiments/muse-glimmer-stress/manifests/).

The invocation for one setting was:

```bash
./.venv/bin/modal run infra/modal/capture_muse_glimmer.py \
  --prompt-tokens 8192 \
  --max-tokens 32 \
  --concurrency 8 \
  --seed 7
```

The completed sweep repeated that command with `--concurrency` set to `1`, `4`, `8`, `16`, `32`, `64`, and `128`. These are separate Modal capture jobs; changing the CLI value changes `max_num_seqs` in the engine as well as the number of submitted requests.

### 6.1 Results

| Submitted requests | TTFT p50 (s) | TTFT p95 (s) | Derived page bytes | Worker allocated peak (GiB) | Worker reserved peak (GiB) | OOM |
|---:|---:|---:|---:|---:|---:|:---|
| 1 | 2.656 | 2.656 | 208 MiB | 71.00 | 71.33 | No |
| 4 | 2.912 | 2.913 | 832 MiB | 71.00 | 71.45 | No |
| 8 | 8.066 | 8.068 | 1,664 MiB | 71.01 | 71.47 | No |
| 16 | 8.437 | 8.441 | 3,328 MiB | 70.99 | 71.48 | No |
| 32 | 7.058 | 7.065 | 6,656 MiB | 71.00 | 71.55 | No |
| 64 | 6.744 | 6.757 | 13,312 MiB | 71.00 | 71.67 | No |
| 128 | 8.983 | 9.018 | 26,624 MiB | 71.01 | 71.80 | No |

The percentiles are across requests in a capture at that concurrency, not confidence intervals across repeated trials. At concurrency 1, p50 and p95 necessarily equal the single request’s TTFT. There is one reported ramp point per concurrency, so the table does not quantify run-to-run variability. The summary records worker allocator and TTFT measurements from repeat capture runs at the same settings; the CSV run IDs identify the per-concurrency manifests. Do not describe these as a multi-trial statistical estimate.

Worker allocated peaks remain close to 71 GiB while reserved peaks rise from 71.33 to 71.80 GiB. The whole-device generation delta samples range from about 1.65 to 1.75 GiB in the CSV. These figures have different scope and must not be combined: worker allocator peaks reflect PyTorch’s allocator inside the model worker after its peak counters were reset; device delta is a sampled whole-GPU change relative to the start of generation.

### 6.2 What “no OOM point” means

No capture in the 1–128 request ramp ended in an OOM. This is a measured outcome: **the experiment did not reach an OOM point**. It does not mean that the GPU has unlimited capacity, that 128 sequences were all resident in the KV cache at once, or that a larger/longer workload could never fail.

The startup logs reported a preallocated KV pool of roughly 13.5 GiB and capacity for about 32 full-length 8,480-token sequences. The request count is not the same thing as simultaneous active sequence residency. The vLLM scheduler can admit work in batches and leave excess requests waiting while reusing the fixed pool. This explains why increasing submitted concurrency can increase waiting/TTFT without forcing the KV pool to grow in proportion to the request count. The measured ramp therefore probes queueing and latency under this scheduler configuration; it does not locate a memory exhaustion boundary.

To measure an OOM boundary, the workload must raise simultaneous memory demand or change the pool/scheduler constraints. That would be a new experiment and needs its own controlled parameters; the current result should simply be reported as “no OOM through 128 submitted requests under the tested configuration.”

### 6.3 Why we cannot claim a stable latency cliff

The measured p95 TTFT sequence is 2.656, 2.913, 8.068, 8.441, 7.065, 6.757, and 9.018 seconds for concurrency 1 through 128. There is a noticeable increase between the 4- and 8-request observations, followed by lower p95 at 32 and 64 and a higher value at 128. This is a non-monotonic curve from single capture points, not a stable threshold. A one-off rise can reflect scheduling, prefill contention, warmup/JIT effects, host scheduling, and run-to-run noise; the current data do not isolate those causes.

Accordingly, the defensible conclusion is: **the 8K prompt shows a latency increase in some higher-concurrency observations, but this ramp does not establish a repeatable latency cliff or a precise concurrency threshold.** Claiming a cliff would require repeated independent runs per concurrency, controlled warmup, randomized or interleaved concurrency order, enough samples for uncertainty intervals, and a fixed definition of the target (for example p95 TTFT exceeding a chosen SLO). The current report does not invent that threshold.

## 7. Runtime version discrepancy that must remain visible

There is a metadata inconsistency in the current source/artifacts. The capture code’s derived-trace header contains the literal string `vLLM 0.28+ / Muse Glimmer BF16`, and the original engineering rationale said Glimmer required vLLM 0.28 or newer. However, the successful baseline manifest and allocator header record the actual runtime as:

```text
vLLM 0.26.1rc1.dev608+g99a10304d
torch 2.13.0+cu130
CUDA 13.0
```

The image tag `vllm/vllm-openai:muse-glimmer` is not a version guarantee. For reproducibility and publication, use the manifest’s runtime as the observed version; do not state that this experiment ran vLLM 0.28+. The hard-coded header should be corrected in a follow-up so it interpolates the actual runtime. The report preserves the discrepancy rather than silently reconciling it.

## 8. Reproduction and artifact commands

### Run one baseline or ramp point

```bash
./.venv/bin/modal run infra/modal/capture_muse_glimmer.py \
  --prompt-tokens 8192 \
  --max-tokens 32 \
  --concurrency 8 \
  --seed 7
```

For the historical ramp, repeat with each concurrency value. The user explicitly required no new GPU work without approval before the baseline/stress work; the commands above document the completed captures and are not a request to rerun them.

### Retrieve a Modal volume run

The captured run directory is committed on Modal volume `rmemfab-traces`. The recorded retrieval pattern was:

```bash
./.venv/bin/modal volume get \
  rmemfab-traces \
  /20261030T000445Z-muse-glimmer \
  runs/traces/glimmer-baseline-final
```

Depending on the Modal CLI version, retrieval may create a nested run-ID directory; check the resulting tree before moving files. The script’s Hugging Face cache volume is `rmemfab-hf-cache`, which preserves completed model blobs across runs.

### Check a downloaded baseline trace

```bash
sha256sum examples/traces/20261030T000445Z-muse-glimmer-derived/kv_trace.jsonl
wc -l examples/traces/20261030T000445Z-muse-glimmer-derived/kv_trace.jsonl
```

Expected values are SHA-256 `d340f5f352c1a9e32289201c50230ffe394e7e6b178d9b535638c360970252ea` and 42,329 lines. The manifest’s `counts.kv_events` is 42,328 because it excludes the header row.

The trace schema is at [`SPECS/trace.schema.json`](../SPECS/trace.schema.json). Baseline-derived events are labeled in the JSONL header and event metadata. Acceptance criteria for replay, policy comparison, and quantitative correctness are still tracked in [`docs/ACCEPTANCE.md`](ACCEPTANCE.md); successful capture alone does not satisfy those separate simulator/replay criteria.

## 9. Sources and implementation references

- [Meta AI Developer Hackathon](https://cerebralvalley.ai/e/meta-ai-developer-hackathon/details)
- [Muse Glimmer 30B model card](https://huggingface.co/meta-models/Muse-Glimmer-30B)
- [Muse Glimmer collection](https://huggingface.co/collections/meta-models/muse-glimmer)
- [Modal: using existing container images](https://modal.com/docs/guide/existing-images)
- [Modal `Image` API](https://modal.com/docs/sdk/py/latest/Image)
- [vLLM metrics definitions](https://github.com/vllm-project/vllm/blob/main/docs/design/metrics.md)
- [PyTorch: understanding CUDA memory usage and snapshots](https://docs.pytorch.org/docs/stable/torch_cuda_memory.html)
- [PyTorch memory snapshot visualizer](https://pytorch.org/memory_viz)
- In-repository capture: [`infra/modal/capture_muse_glimmer.py`](../infra/modal/capture_muse_glimmer.py)
- In-repository baseline manifest and derived trace: [`examples/traces/20261030T000445Z-muse-glimmer-derived/`](../examples/traces/20261030T000445Z-muse-glimmer-derived/)
- In-repository stress summary and per-setting manifests: [`examples/experiments/muse-glimmer-stress/`](../examples/experiments/muse-glimmer-stress/)
- In-repository schema and acceptance contract: [`SPECS/trace.schema.json`](../SPECS/trace.schema.json), [`docs/ACCEPTANCE.md`](ACCEPTANCE.md)

## 10. Conclusions and open work

The project resolved the Modal image startup issues, resumed the cached Glimmer weights, completed a real A100 baseline, produced a hashed derived KV trace, and extended the capture to measure request TTFT and worker-side allocator peaks. The ramp completed through 128 submitted requests without OOM. TTFT and memory counters are now available, but the latency curve is non-monotonic and too sparsely sampled to support a stable cliff claim.

For an article or presentation, the accurate headline is: **RmemFab captured a real Muse Glimmer request workload on Modal and generated a replayable page trace; the KV events are derived from measured tokens and model geometry, while allocator events are absent because the cache is preallocated. Under the tested 8K/32-token configuration, no OOM occurred through 128 submitted requests, and the available TTFT observations do not establish a stable latency cliff.**

Before making stronger performance claims, the remaining work is to correct the hard-coded vLLM header, verify and publish the exact runtime, repeat each concurrency point enough times to estimate uncertainty, capture an actual OOM boundary only if that is a useful question, and validate replay/policy outputs against the acceptance contract. The existing report does not claim those follow-up results.
