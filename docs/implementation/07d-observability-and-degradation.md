# Slice 07d: Observability and Degradation

> **Goal:** Add structured observability and predictable degraded-path behavior around the stabilized runtime so failures are inspectable, bounded, and non-fatal.

**Prerequisites:** Slices 01-06 and 07a-07c.

**Architecture references:** docs/architecture.md — LLM Interface, Policy Layer, Schedule System Design

---

## What This Slice Delivers

1. Structured JSON logging for runtime lifecycle and execution events.
2. Logged, bounded behavior for degraded transport/provider/database paths.
3. Explicit SQLite lock and LLM-outage handling instead of process-level failure.
4. A full primitive/runtime error audit with consistent `success: false` surfaces.

---

## Key Tasks

### Task 07d.1: Add a Structured Logger
- Introduce a JSON-lines logger that writes to `~/.agent/logs/agent.log`.
- Wire it into the core runtime paths first:
  - `src/index.ts`
  - `src/runtime/agent.ts`
  - `src/primitives/dispatcher.ts`
  - `src/policy/engine.ts`
  - `src/scheduler/service.ts`
  - `src/llm/openai.ts`
- Replace daemon/runtime `console.log` / `console.warn` / `console.error` calls. Manual helper scripts can stay out of scope.
- Keep log rotation deferred.

### Task 07d.2: Harden Degraded Provider and Transport Paths
- LLM API unreachable:
  - interactive session returns an actionable error to the user
  - triggered session records failure and ends cleanly
  - daemon stays alive
- WebSocket disconnected:
  - the current `src/communication/websocket.ts` queue is unbounded; cap it at 100 messages or 1MB
  - deliver buffered messages in order on reconnect
  - drop oldest entries on overflow and log a warning

### Task 07d.3: Add SQLite Lock Handling and Error Audits
- Add retry/backoff for SQLite lock contention while preserving the existing WAL setup in `src/db/database.ts`.
- Audit primitive/runtime error paths in:
  - `src/primitives/memory.ts`
  - `src/primitives/file.ts`
  - `src/primitives/execute/handler.ts`
  - `src/primitives/schedule.ts`
  - interpreter modules under `src/interpreter/`
- Every audited failure path should return a clean structured error instead of leaking an unhandled exception.

### Task 07d.4: Verify Observability and Degraded Behavior
- Add targeted coverage for:
  - log emission on key lifecycle events
  - LLM outage handling
  - SQLite lock retry/failure behavior
  - WebSocket buffer overflow behavior
  - primitive error shaping

---

## Definition of Done

1. The daemon emits structured JSON logs for session lifecycle, primitive calls, policy decisions, schedule fires, LLM calls, and errors.
2. LLM/network outages return actionable failures without crashing the daemon.
3. WebSocket buffering is bounded and overflow behavior is deterministic and logged.
4. SQLite lock contention retries and then fails cleanly when needed.
5. Audited primitive/runtime paths return structured failures and do not leak unhandled promise rejections.

---

## Why It Is Ordered Here / Dependency Note

- This slice is last because it is cross-cutting: it should wrap stable triggered-session, compaction, and continuity behavior rather than land while those contracts are still moving.
