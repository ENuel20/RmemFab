"""RmemFab demo deployment on Modal (single public URL).

Serves the FastAPI engine + built dashboard from one endpoint, with
persistent runs/traces volumes and the Baseten key from a Modal secret.

Prerequisites (run once, in your own terminal with network):

    pip install modal                # or: .venv/bin/pip install modal
    modal setup                      # browser login; skips if ~/.modal.toml exists
    modal secret create rmemfab-baseten BASETEN_API_KEY=<key from .env>

Deploy / update (dashboard/dist is gitignored, so build it first):

    make dashboard-dist            # fresh bundle; Modal bakes your local dist/
    modal deploy deploy/modal_app.py # prints the public https URL

Then open the printed URL: dashboard + API, same origin. No assistant
key configured server-side? The Assistant shows its 503 hint; every
other view works fully offline.

Notes and honest limits:

- Code + dashboard bundle + examples are baked into the image at
  deploy time; redeploy after changing them (volumes keep runs/traces).
- Volumes persist runs across deploys and restarts. Keep one replica
  for the demo (default) so every request sees the same filesystem.
- Cold starts take ~10-30s after idle; engine runs then behave exactly
  like local ones (same code, same determinism).
- `modal app stop rmemfab-demo` tears the deployment down.
"""

import modal

app = modal.App("rmemfab-demo")

image = (
    modal.Image.debian_slim(python_version="3.12")
    .pip_install(
        "numpy>=1.24",
        "fastapi>=0.110",
        "uvicorn[standard]>=0.29",
        "httpx>=0.27",
        "python-multipart>=0.0.9",
    )
    .add_local_dir("src", "/app/src")
    .add_local_dir("dashboard/dist", "/app/dashboard/dist")
    .add_local_dir("examples", "/app/examples")
    # Replayable traces at the server-CWD-relative paths scenarios use.
    # (The invalid Glimmer trace is deliberately NOT baked in.)
    .add_local_dir(
        "examples/traces/20261029T202303Z-opt-125m",
        "/app/traces/20261029T202303Z-opt-125m",
    )
    .add_local_dir(
        "examples/traces/20261101T152247Z-baseten-spark",
        "/app/traces/20261101T152247Z-baseten-spark",
    )
)

runs_vol = modal.Volume.from_name("rmemfab-runs", create_if_missing=True)
traces_vol = modal.Volume.from_name("rmemfab-traces", create_if_missing=True)


@app.function(
    image=image,
    secrets=[modal.Secret.from_name("rmemfab-baseten")],
    volumes={"/app/runs": runs_vol, "/app/traces/uploads": traces_vol},
    timeout=1800,
)
@modal.asgi_app()
def serve():
    import os
    import sys

    sys.path.insert(0, "/app/src")
    os.chdir("/app")  # CWD-relative runs/traces/dist + example trace paths
    from rmemfab.api import create_app

    return create_app(
        runs_dir="/app/runs",
        traces_dir="/app/traces/uploads",
        static_dir="/app/dashboard/dist",
    )
