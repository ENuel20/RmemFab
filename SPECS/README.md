# Specifications

This directory contains the versioned contracts between the simulator core, workloads, tooling, and the dashboard.

| File | Contract |
| :--- | :--- |
| [`config.schema.json`](config.schema.json) | Scenario configuration (the input to a run) |
| [`trace.schema.json`](trace.schema.json) | Memory access trace records (JSONL) |
| [`events.md`](events.md) | Event types emitted by the core |

## Versioning

- The scenario and trace formats are versioned with a `version` / `trace_version` string.
- A version is bumped when a change would break existing files.
- Additive optional fields do not require a version bump, but must be documented.
- The simulator records the schema version in every run manifest.

## Validation

Scenarios must validate before any simulation starts. The same schema is used by the CLI, the API, and the dashboard editor, so a file that validates in one place validates everywhere.

Trace records are validated line by line. A malformed line stops import unless the importer is explicitly run in best-effort mode, in which case rejected lines are counted and reported.

## Provenance

Hardware and model parameters may carry a `provenance` block:

```json
{
  "kind": "measured | sourced | assumed",
  "source": "citation, datasheet, dataset, or benchmark",
  "method": "how the value was obtained or fitted",
  "date": "2026-10-28",
  "uncertainty_pct": 25,
  "notes": "optional"
}
```

Scenarios may also list top-level `assumptions` strings. Both fields are optional and additive, so they do not change the schema version. A run intended for absolute claims should be validated with provenance required; missing provenance is a warning, not a silent pass. The dashboard must show assumed values next to the verdict.

## Compatibility policy

- **Patch releases:** no schema changes.
- **Minor releases:** optional fields only; old scenarios remain valid.
- **Major releases:** may change required fields or semantics; migration notes are required.

## Canonicalization

The manifest hash is computed over a canonical form of the scenario:

1. Object keys sorted lexicographically.
2. Numbers serialized in a stable format.
3. Whitespace removed.
4. No environment-dependent fields.

Two scenarios that differ only in formatting must hash identically.

## Example scenarios

[`../examples/llama-70b-cxl.json`](../examples/llama-70b-cxl.json) and [`../examples/moe-remote-tiering.json`](../examples/moe-remote-tiering.json) are normative examples: they must validate against the schemas in this directory.
