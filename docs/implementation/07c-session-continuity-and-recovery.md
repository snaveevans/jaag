# Slice 07c: Session Continuity and Recovery

> **Goal:** Carry forward useful context across new sessions and make startup/restart recovery explicit, using the current session, scheduler, and SQLite architecture rather than inventing a second persistence model.

**Prerequisites:** Slices 01-06, 07a, and 07b.

**Architecture references:** docs/architecture.md — Memory System Design, Schedule System Design, The `interact` Blocking Problem

---

## What This Slice Delivers

1. A bounded continuity block for new interactive sessions sourced from recent summaries and safe long-lived preference keys.
2. Clear rules for which persisted memory entries are eligible for startup continuity.
3. Startup integrity and recovery checks around SQLite and interrupted schedule work.
4. Recovery behavior that matches the current runtime schema instead of relying on undocumented states.

---

## Key Tasks

### Task 07c.1: Load Continuity Context at Interactive Session Start
- Extend session bootstrap in `src/index.ts`, `src/session/manager.ts`, and `src/runtime/system-prompt.ts` so a new interactive session can inject a short continuity block.
- Source that block from recent `session_summary:*` entries created in 07b plus a small allowlisted set of long-lived user context keys.
- Keep triggered sessions instruction-first in this slice; do not auto-load broad memory into schedule fires.

### Task 07c.2: Define Safe Continuity Inputs
- Formalize a small key convention for continuity-safe memories instead of loading arbitrary memory rows.
- Ensure the continuity block is bounded so it does not immediately recreate the context-budget problem solved in 07b.
- Exclude operational or secret-bearing entries from startup injection.

### Task 07c.3: Add Startup Integrity and Recovery Checks
- Add `PRAGMA integrity_check` during database startup in `src/db/database.ts` or adjacent initialization.
- Define how interrupted schedule execution is marked and recovered on restart in a way that matches the current schema.
- Note: the current `src/scheduler/types.ts` models `last_fire_status` as `success | failed`, so recovery cannot depend on an undocumented `running` state without first extending that contract deliberately.
- Preserve the existing stale PID cleanup already implemented in `src/runtime/pid.ts`.

### Task 07c.4: Prove Continuity and Recovery Behavior
- Add tests for:
  - continuity block construction
  - SQLite integrity failure handling
  - crash/restart reconciliation of interrupted schedule work

---

## Definition of Done

1. A new interactive session starts with a small, explicit continuity block built from recent summaries and safe long-lived context keys.
2. Triggered sessions remain aligned with the architecture's instruction-first contract unless a later slice changes that deliberately.
3. Startup runs an integrity check and fails or recovers clearly instead of silently using a corrupt database.
4. Crash recovery semantics for interrupted schedule work are explicit and consistent with the actual schedule schema.
5. Existing stale PID handling continues to work.

---

## Why It Is Ordered Here / Dependency Note

- This slice depends on 07b because it consumes the summaries produced there.
- It comes before 07d so logging and degraded-path work can instrument a settled continuity/recovery model rather than a moving target.
