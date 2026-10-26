# Events

The core emits structured events to the telemetry stream. This document defines the canonical event types and their fields. Event payloads are JSON objects with a common envelope.

## Envelope

```json
{
  "event": "page_access",
  "time_ns": 123456,
  "seq": 42,
  "run_id": "01J...",
  "node": "node-0",
  "request_id": "req-17",
  "data": {}
}
```

| Field | Type | Required | Meaning |
| :--- | :--- | :--- | :--- |
| `event` | string | yes | Event name from the tables below |
| `time_ns` | integer | yes | Virtual time in nanoseconds |
| `seq` | integer | yes | Monotonic scheduling sequence |
| `run_id` | string | yes | Run identifier from the manifest |
| `node` | string | no | Node associated with the event |
| `request_id` | string | no | Request or tenant context |
| `data` | object | yes | Event-specific payload |

Unknown events must be preserved by consumers but may be ignored.

## Request lifecycle

| Event | Payload |
| :--- | :--- |
| `request_arrival` | `request_id`, `class`, `prompt_tokens`, `generated_tokens` |
| `prefill_begin` | `request_id`, `tokens` |
| `prefill_end` | `request_id`, `duration_ns` |
| `decode_step` | `request_id`, `token_index` |
| `request_complete` | `request_id`, `tokens_generated`, `latency_ns` |

## Memory

| Event | Payload |
| :--- | :--- |
| `page_allocate` | `page_id`, `bytes`, `tier`, `owner` |
| `page_access` | `page_id`, `bytes`, `op` (`read`/`write`), `tier` |
| `page_hit` | `page_id`, `tier`, `latency_ns` |
| `page_miss` | `page_id`, `requested_tier`, `found_tier` |
| `page_evict` | `page_id`, `tier`, `bytes`, `dirty` |
| `page_migrate_begin` | `page_id`, `from_tier`, `to_tier`, `bytes` |
| `page_migrate_end` | `page_id`, `from_tier`, `to_tier`, `bytes`, `duration_ns` |
| `page_free` | `page_id`, `tier`, `bytes` |

## Fabric

| Event | Payload |
| :--- | :--- |
| `transfer_begin` | `link`, `bytes`, `from_node`, `to_node`, `kind` |
| `transfer_complete` | `link`, `bytes`, `duration_ns`, `queue_delay_ns` |
| `link_congested` | `link`, `queue_bytes`, `utilization` |
| `link_degraded` | `link`, `bandwidth_factor`, `latency_factor` |
| `link_restored` | `link` |
| `transfer_dropped` | `link`, `bytes`, `reason` |

## Prefetch

| Event | Payload |
| :--- | :--- |
| `prefetch_issue` | `page_id`, `destination`, `confidence` |
| `prefetch_complete` | `page_id`, `destination`, `duration_ns` |
| `prefetch_used` | `page_id`, `distance_ns` |
| `prefetch_wasted` | `page_id`, `evicted_before_use` |

## Faults

| Event | Payload |
| :--- | :--- |
| `node_fail` | `node`, `reason` |
| `node_recover` | `node`, `downtime_ns` |
| `fault_injected` | `kind`, `target`, `parameters` |

## Policy

| Event | Payload |
| :--- | :--- |
| `policy_decision` | `policy`, `decision`, `page_id`, `reason` |
| `policy_pressure` | `policy`, `tier`, `occupancy_bytes`, `capacity_bytes` |
| `policy_tick` | `policy`, `migrations_pending` |

## Control and metrics

| Event | Payload |
| :--- | :--- |
| `run_start` | `scenario_hash`, `seed`, `version` |
| `sampling_tick` | `interval_ns` |
| `run_end` | `events_processed`, `virtual_time_ns`, `status` |
| `metric_snapshot` | `window_ns`, metric-specific fields |

## Ordering guarantees

1. Events are emitted in nondecreasing `time_ns`.
2. Events with the same `time_ns` are emitted in increasing `seq`.
3. Begin/end pairs are guaranteed for transfers and migrations unless a fault interrupts them; interrupted operations emit a terminal event with a `status` field.
4. The event log is append-only and must not be reordered by exporters.

## Size considerations

Event logs for long runs can be large. Consumers should:

- Prefer streaming reads.
- Use `output.include_event_log = false` for summary-only runs.
- Export to Parquet for analytical queries.
- Filter by event type at write time when configured.

## Compatibility

Event names and required fields are stable within a major version. New optional fields may be added. Consumers must ignore unknown fields and unknown event types rather than failing.
