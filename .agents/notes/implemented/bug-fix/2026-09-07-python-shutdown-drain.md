# Agent Note: Python SDK shutdown preserves the final log drain

Status: implemented

## Problem

The JSON-RPC runtime acknowledges shutdown before disposing plugins and draining session persistence. The Python client terminated the process immediately after that acknowledgement. On Windows, termination could discard the final turn and an entire short-lived child log.

## Decision

The client closes stdin and waits for process exit before escalating to termination and then kill. Each wait uses the existing `shutdown_timeout_seconds` setting. The advanced snapshot composition mounts semantic checkpoints alongside persistence, matching the runtime's durable research accounting requirements.

## Alternatives considered

**Sleep after the reply.** Rejected because elapsed time does not prove the persistence drain completed. Process exit is the existing completion signal.

**Wait without a bound.** Rejected because a broken runtime must not hold client cleanup indefinitely.

## Consequences

Closing a healthy runtime waits for its persistence drain. A hung runtime can consume the configured timeout at each escalation stage; callers requiring faster cleanup can lower the existing setting.

## Verification

A subprocess test acknowledges shutdown, performs delayed cleanup, and writes a marker before exiting. The Python SDK snapshot runs the real built runtime and verifies complete parent and child logs after close. Timeout tests retain bounded cleanup for an unresponsive process.
