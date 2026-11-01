"""JSONL telemetry writers."""
from __future__ import annotations

import json


class JsonlWriter:
    def __init__(self, path):
        self._f = open(path, "w", encoding="utf-8", newline="\n", buffering=1 << 20)
        self.count = 0

    def write(self, obj: dict) -> None:
        self._f.write(json.dumps(obj, separators=(",", ":")))
        self._f.write("\n")
        self.count += 1

    def close(self) -> None:
        f, self._f = self._f, None
        if f is not None:
            f.close()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()
        return False


class NullWriter:
    count = 0

    def write(self, obj: dict) -> None:
        pass

    def close(self) -> None:
        pass

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False
