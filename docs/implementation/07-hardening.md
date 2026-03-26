# Slice 07: Hardening

> **Goal:** Make the runtime durable enough for daily use by splitting hardening into smaller, durable sub-slices instead of one broad catch-all pass.

**Prerequisites:** Slices 01-06. Start with 07a before taking the rest of the hardening track.

**Architecture references:** docs/architecture.md — LLM Interface, Memory System Design, Schedule System Design, Policy Layer; docs/known-bugs/scheduled-trigger-execution.md

---

## Why Slice 07 Is Split

The current codebase already has several hardening-adjacent foundations in place:

- triggered sessions and scheduler handoff (`src/scheduler/service.ts`, `src/runtime/agent.ts`)
- shared SQLite initialization with WAL (`src/db/database.ts`)
- stale PID cleanup (`src/runtime/pid.ts`)
- basic WebSocket buffering (`src/communication/websocket.ts`)

What remains is still too broad for one implementation slice, and the open scheduled-trigger bug means later hardening work would otherwise be validated on a known-bad execution path. Slice 07 therefore stays as the umbrella/index doc, with the actual implementation work split into four ordered child slices.

---

## Sub-Slices

| Sub-slice | Focus | Original task mapping |
| --- | --- | --- |
| [07a-triggered-session-stabilization.md](./07a-triggered-session-stabilization.md) | Stabilize the known fired-schedule / triggered-session bug before broader hardening | New prerequisite slice driven by the open bug |
| [07b-context-budget-and-compaction.md](./07b-context-budget-and-compaction.md) | Budget tracking, compaction, persisted summaries | Original 7.1-7.2 |
| [07c-session-continuity-and-recovery.md](./07c-session-continuity-and-recovery.md) | Continuity on new sessions and startup/restart recovery | Original 7.4 and 7.7 |
| [07d-observability-and-degradation.md](./07d-observability-and-degradation.md) | Structured logging, graceful degradation, error audit | Original 7.3, 7.5, 7.6 |

---

## Sequencing

1. **07a first:** restore reliable triggered-session execution and remove the known blocker.
2. **07b next:** add context budget tracking and compaction once both interactive and triggered paths are trustworthy enough to measure.
3. **07c then:** consume persisted summaries for continuity and formalize recovery behavior on startup/restart.
4. **07d last:** add cross-cutting observability and degraded-path polish around the now-stable runtime behavior.

The child docs own the implementation detail. This parent doc only defines the split, the dependency order, and the current-state framing for the work.
