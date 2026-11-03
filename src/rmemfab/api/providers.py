"""Baseten client for assistant features (Meta Muse models only).

Used by draft (NL -> scenario JSON) and chat (streamed explanations).
Simulation paths never import this module: providers assist around the
simulator, never inside it. The key comes from BASETEN_API_KEY (env or
repo-root .env) and is never logged, returned, or written anywhere.
"""
from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from pathlib import Path

MODEL = "meta-models/muse-spark-open-1026"
BASE_URL = "https://inference.baseten.co/v1/chat/completions"
TIMEOUT_S = 120


class ProviderError(Exception):
    pass


class ProviderNotConfigured(Exception):
    pass


def load_key() -> str:
    key = os.environ.get("BASETEN_API_KEY")
    if key:
        return key
    env = Path(__file__).resolve().parent.parent.parent.parent / ".env"
    if env.is_file():
        for line in env.read_text(encoding="utf-8").splitlines():
            if line.startswith("BASETEN_API_KEY="):
                return line.split("=", 1)[1].strip()
    raise ProviderNotConfigured("baseten not configured (BASETEN_API_KEY)")


class BasetenClient:
    def __init__(self, key=None, model=MODEL, base_url=BASE_URL):
        self.key = key if key is not None else load_key()
        self.model = model
        self.base_url = base_url
        if "muse" not in self.model.lower() and "meta" not in self.model.lower():
            raise ProviderError(f"refusing non-Muse model {self.model!r}")

    def _request(self, payload: dict):
        req = urllib.request.Request(
            self.base_url, data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json",
                     "Authorization": f"Bearer {self.key}"})
        try:
            return urllib.request.urlopen(req, timeout=TIMEOUT_S)
        except urllib.error.HTTPError as exc:
            try:
                detail = exc.read().decode()[:500]
            except Exception:
                detail = ""
            raise ProviderError(
                f"baseten HTTP {exc.code}: {detail}") from None
        except Exception as exc:  # noqa: BLE001 - transport failure
            raise ProviderError(f"baseten transport: {exc}") from None

    def chat(self, messages, *, max_tokens=8000, temperature=0,
             json_mode=False) -> dict:
        payload = {"model": self.model, "messages": messages,
                   "max_tokens": max_tokens, "temperature": temperature}
        if json_mode:
            payload["response_format"] = {"type": "json_object"}
        with self._request(payload) as resp:
            data = json.loads(resp.read())
        try:
            msg = data["choices"][0]["message"]
        except (KeyError, IndexError):
            raise ProviderError(f"unexpected baseten shape: {str(data)[:300]}")
        content = msg.get("content")
        if content is None:
            raise ProviderError(
                "empty content (reasoning consumed the budget; retry with "
                "more max_tokens)")
        return {"content": content,
                "usage": data.get("usage", {}),
                "model": data.get("model", self.model)}

    def chat_stream(self, messages, *, max_tokens=8000, temperature=0.2):
        """Yield raw SSE data payloads (dicts); raises ProviderError."""
        payload = {"model": self.model, "messages": messages,
                   "max_tokens": max_tokens, "temperature": temperature,
                   "stream": True,
                   "stream_options": {"include_usage": True}}
        try:
            resp = self._request(payload)
        except ProviderError:
            raise
        with resp:
            for raw in resp:
                line = raw.decode("utf-8", "replace").strip()
                if not line.startswith("data:"):
                    continue
                payload_text = line[5:].strip()
                if payload_text == "[DONE]":
                    return
                try:
                    yield json.loads(payload_text)
                except json.JSONDecodeError:
                    continue
