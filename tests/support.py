"""Shared test helpers (not a test module)."""
import copy
import json
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent


def load_example(name: str) -> dict:
    return json.loads((REPO / "examples" / name).read_text(encoding="utf-8"))


def write_tmp_scenario(raw: dict) -> str:
    f = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8")
    json.dump(raw, f)
    f.close()
    return f.name


def tmp_scenario(name: str, mutator=None) -> str:
    raw = load_example(name)
    if mutator is not None:
        mutator(raw)
    return write_tmp_scenario(raw)


def run_engine(scenario_path: str, outdir: str, *, event_log=True):
    from rmemfab.config.scenario import build_scenario, load_raw
    from rmemfab.core.engine import Engine
    sc = build_scenario(load_raw(scenario_path))
    return Engine(sc, outdir, event_log=event_log).run()


def read_jsonl(path: str) -> list:
    out = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                out.append(json.loads(line))
    return out
