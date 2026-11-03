# RmemFab one-command workflows. `make dev` is the single entry point:
# one server, one URL (http://127.0.0.1:8000 serves API + dashboard).
VENV ?= .venv
RMEMFAB := $(VENV)/bin/rmemfab

.PHONY: help dev test test-backend test-dashboard dashboard-dist

help:
	@echo "make dev            - serve API + dashboard on :8000 (single URL)"
	@echo "make test           - backend + dashboard suites"
	@echo "make test-backend   - python unittest suite (from tests/)"
	@echo "make test-dashboard - dashboard node:test suite"
	@echo "make dashboard-dist - rebuild the static dashboard bundle"

$(VENV)/bin/rmemfab:
	@echo "creating venv and installing (needs network for dependencies)"
	python3 -m venv $(VENV)
	$(VENV)/bin/pip install -e '.[api]'

dev: $(VENV)/bin/rmemfab
	@if [ ! -f dashboard/dist/index.html ]; then \
	  echo "NOTE: no dashboard build at dashboard/dist — serving API only."; \
	  echo "Run 'make dashboard-dist' (needs npm install in dashboard/) for single-URL mode,"; \
	  echo "or use the vite dev server: cd dashboard && npm run dev  # :5173"; \
	elif [ -n "$$(find dashboard/src -newer dashboard/dist/index.html -print -quit)" ]; then \
	  echo "WARNING: dashboard sources are newer than dashboard/dist — serving a stale build."; \
	  echo "Run 'make dashboard-dist' to refresh, or use the vite dev server for live reload."; \
	fi
	$(RMEMFAB) serve

test: test-backend test-dashboard

test-backend: $(VENV)/bin/rmemfab
	cd tests && PYTHONPATH=../src:. ../$(VENV)/bin/python -m unittest

test-dashboard:
	cd dashboard && npm test

dashboard-dist:
	cd dashboard && npm run build
