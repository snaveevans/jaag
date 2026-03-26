# Slice 07a: Triggered Session Stabilization

> **Goal:** Restore reliable fired-schedule execution before broader hardening. This slice exists to close the open bug documented in `docs/known-bugs/scheduled-trigger-execution.md` and re-establish trust in triggered-session behavior.

**Prerequisites:** Slices 01-06; the current scheduler/triggered-session runtime from Slice 05; `docs/known-bugs/scheduled-trigger-execution.md` is the explicit starting point.

**Architecture references:** docs/architecture.md — Schedule System Design (Execution Model, The `interact` Blocking Problem), LLM Interface; docs/known-bugs/scheduled-trigger-execution.md

---

## What This Slice Delivers

1. A reproducible failing test for the current schedule-fire → triggered-session regression.
2. A minimal fix in the actual failing boundary (scheduler handoff, triggered-session runtime, or provider translation).
3. Reliable end-to-end execution for fired schedules that reach `interact(mode: notify)`.
4. Clear success/failure recording for triggered runs without daemon crashes.

---

## Key Tasks

### Task 07a.1: Reproduce the Known Bug in the Fired Path
- Use `docs/known-bugs/scheduled-trigger-execution.md` as the canonical repro.
- Add or tighten regression coverage for:
  - schedule creation
  - scheduler fire
  - triggered-session bootstrap
  - tool-call follow-up through `interact(mode: notify)`

### Task 07a.2: Compare Triggered and Interactive Runtime Contracts
- Inspect `src/scheduler/service.ts`, `src/runtime/agent.ts`, `src/session/manager.ts`, and `src/runtime/system-prompt.ts`.
- Verify triggered runs preserve the same provider-facing message/tool-call contract as interactive runs, except for the intentional schedule context block.
- Treat this as stabilization work, not a redesign of scheduling or prompting.

### Task 07a.3: Patch the Smallest Failing Boundary
- Fix the actual break where it occurs:
  - schedule-fire to session handoff
  - triggered-session runtime/bootstrap
  - provider request translation in `src/llm/openai.ts`
- Keep the change narrow. Do not fold in broader hardening work here.

### Task 07a.4: Lock In Execution-Status and Regression Coverage
- Add coverage that proves:
  - fired schedules can complete a `notify` interaction end-to-end
  - provider/tool-call follow-up works for triggered runs
  - failed fires record `last_fire_status = 'failed'` and do not crash the daemon

---

## Definition of Done

1. A fired schedule that reaches `interact(mode: notify)` succeeds end-to-end in regression coverage.
2. The root cause documented in `docs/known-bugs/scheduled-trigger-execution.md` is isolated and fixed at the correct boundary.
3. Triggered sessions are no longer a known unreliable path for later hardening work.
4. Failed triggered executions surface cleanly and leave the runtime alive.

---

## Why It Is Ordered Here / Dependency Note

- This slice is first because the open scheduled-trigger bug is an explicit blocker.
- 07b-07d all depend on trustworthy triggered-session behavior; otherwise compaction, continuity, logging, and degraded-path work would be tested against the wrong failure source.
