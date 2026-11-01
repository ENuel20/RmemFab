"""Batch serving sweep on Baseten (Meta Muse models only).

Generates multi-user request distributions: variable prompt lengths served
at several concurrency levels, recording per-request arrival time,
time-to-first-token (via streaming), total latency, and token usage.
Output is a raw request log (JSONL) -- request-level evidence only.
Page operations are derived later by tools/baseten_log_to_trace.py and
labeled derived; nothing here claims block-table measurement.

Key handling: BASETEN_API_KEY from the environment or the repo-root .env
file. The key is never printed, never written to outputs, and never
accepted as a CLI argument.

Example:
    python3 infra/baseten/generate.py --prompt-lens 256,1024,4096 \\
        --concurrencies 1,4,16 --requests-per-cell 8 --out /tmp/basen.jsonl
"""
from __future__ import annotations

import argparse
import json
import os
import random
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

MODEL = "meta-models/muse-spark-open-1026"
BASE_URL = "https://inference.baseten.co/v1/chat/completions"
MAX_TOKENS = 128  # completion cap; content is irrelevant, timing is the data
TIMEOUT_S = 300

SENTENCE = ("RmemFab models disaggregated memory fabrics for long-context "
            "inference serving. ")


def load_key() -> str:
    key = os.environ.get("BASETEN_API_KEY")
    if key:
        return key
    env = Path(__file__).resolve().parent.parent.parent / ".env"
    if env.is_file():
        for line in env.read_text(encoding="utf-8").splitlines():
            if line.startswith("BASETEN_API_KEY="):
                return line.split("=", 1)[1].strip()
    raise SystemExit("BASETEN_API_KEY not found (env or repo-root .env)")


def build_prompt(target_tokens: int, seed: int) -> str:
    """Deterministic pseudo-text of roughly target_tokens (~4 chars/token)."""
    rng = random.Random(seed)
    words = SENTENCE.split()
    out, n = [], 0
    while n < target_tokens * 4:
        w = rng.choice(words)
        out.append(w)
        n += len(w) + 1
    return " ".join(out) + "\nSummarize the above in one sentence."


def one_request(key: str, prompt: str, request_id: str) -> dict:
    """Stream one completion; return the timing/usage row (no key, no text)."""
    body = json.dumps({"model": MODEL,
                       "messages": [{"role": "user", "content": prompt}],
                       "max_tokens": MAX_TOKENS, "temperature": 0,
                       "stream": True}).encode()
    req = urllib.request.Request(
        BASE_URL, data=body,
        headers={"Content-Type": "application/json",
                 "Authorization": f"Bearer {key}"})
    arrival = time.time()
    first_token, usage = None, {}
    finish = None
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_S) as resp:
            for raw in resp:
                line = raw.decode("utf-8", "replace").strip()
                if not line.startswith("data:"):
                    continue
                payload = line[5:].strip()
                if payload == "[DONE]":
                    break
                try:
                    chunk = json.loads(payload)
                except json.JSONDecodeError:
                    continue
                if first_token is None:
                    first_token = time.time()
                for ch in chunk.get("choices", []):
                    if ch.get("finish_reason"):
                        finish = ch["finish_reason"]
                if chunk.get("usage"):
                    usage = chunk["usage"]
    except Exception as exc:  # noqa: BLE001 - recorded, never raised
        return {"request_id": request_id, "error": f"{type(exc).__name__}"}
    end = time.time()
    return {"request_id": request_id,
            "prompt_tokens": usage.get("prompt_tokens"),
            "completion_tokens": usage.get("completion_tokens"),
            "arrival_ts": arrival, "first_token_ts": first_token,
            "end_ts": end,
            "ttft_ms": ((first_token - arrival) * 1000
                        if first_token else None),
            "total_ms": (end - arrival) * 1000,
            "finish_reason": finish}


def run_cell(key: str, prompt_len: int, concurrency: int, count: int,
             seed: int, cell: str) -> list:
    rng = random.Random(seed)
    rows = []

    def task(i: int):
        rid = f"{cell}-r{i}"
        # Seeded think-time jitter emulates independent users, not lockstep.
        time.sleep(rng.uniform(0, 0.25))
        row = one_request(key, build_prompt(prompt_len, hash(rid) % (1 << 31)),
                          rid)
        row["prompt_target_tokens"] = prompt_len
        row["concurrency"] = concurrency
        row["cell"] = cell
        return row

    with ThreadPoolExecutor(max_workers=concurrency) as pool:
        rows = list(pool.map(task, range(count)))
    return rows


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--prompt-lens", default="256,1024,4096")
    ap.add_argument("--concurrencies", default="1,4,16")
    ap.add_argument("--requests-per-cell", type=int, default=8)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--out", required=True)
    a = ap.parse_args(argv)
    key = load_key()
    lens = [int(x) for x in a.prompt_lens.split(",")]
    concs = [int(x) for x in a.concurrencies.split(",")]
    header = {"type": "baseten_raw_log", "tool": "infra/baseten/generate.py",
              "model": MODEL, "started_at": datetime.now(timezone.utc).isoformat(),
              "prompt_lens": lens, "concurrencies": concs,
              "requests_per_cell": a.requests_per_cell, "seed": a.seed,
              "max_tokens": MAX_TOKENS, "temperature": 0}
    out = Path(a.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    n_ok = n_err = 0
    tot_prompt = tot_comp = 0
    with open(out, "w", encoding="utf-8") as f:
        f.write(json.dumps(header) + "\n")
        for li, plen in enumerate(lens):
            for ci, conc in enumerate(concs):
                cell = f"L{plen}-C{conc}"
                print(f"cell {cell} ...", flush=True)
                for row in run_cell(key, plen, conc, a.requests_per_cell,
                                    a.seed * 1000 + li * 100 + ci, cell):
                    f.write(json.dumps(row) + "\n")
                    if "error" in row:
                        n_err += 1
                    else:
                        n_ok += 1
                        tot_prompt += row.get("prompt_tokens") or 0
                        tot_comp += row.get("completion_tokens") or 0
    print(f"done: {n_ok} ok, {n_err} errors, "
          f"prompt_tokens={tot_prompt} completion_tokens={tot_comp}")
    print(f"raw log: {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
