# Slice 05: Scheduling

> **Goal:** The agent can schedule future actions — reminders, recurring tasks, periodic checks. This is what makes the agent proactive instead of purely reactive.

**Prerequisites:** Slice 01 (Skeleton), Slice 02 (Memory — shared SQLite database)

**Architecture references:** docs/architecture.md — Schedule System Design, Primitive Execution (`schedule`), Core Loop (scheduler tick)

---

## What This Slice Delivers

1. Schedule table in SQLite
2. Fully functional `schedule` primitive (create, get, list, update, delete)
3. Cron expression parser for computing `next_fire_at`
4. Scheduler tick loop (5-second interval) integrated into the core loop
5. Triggered sessions: schedule fires → new agent session → runs instruction → ends
6. Catch-up behavior on missed triggers
7. Async handoff for interact in triggered sessions (2-minute timeout)

---

## Tasks

### Task 5.1: Schedule Table
- Add schedule table to database migrations:
  ```sql
  CREATE TABLE IF NOT EXISTS schedules (
    id TEXT PRIMARY KEY,           -- UUID
    workflow TEXT NOT NULL,         -- label for grouping
    group_name TEXT,               -- batch operations
    instruction TEXT NOT NULL,     -- what the agent should do
    trigger_type TEXT NOT NULL,    -- 'cron', 'once', 'event'
    trigger_config TEXT NOT NULL,  -- JSON: { cron: "...", timezone: "..." } or { at: "ISO8601" }
    status TEXT NOT NULL DEFAULT 'active',  -- 'active', 'paused', 'completed', 'expired'
    next_fire_at TEXT,             -- ISO 8601, computed from trigger
    last_fire_at TEXT,             -- ISO 8601
    last_fire_status TEXT,         -- 'success', 'failed', 'timeout'
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX idx_schedules_next_fire ON schedules(next_fire_at) WHERE status = 'active';
  ```

### Task 5.2: Cron Parser
- Implement (or use lightweight dependency) cron expression parsing
- Support standard 5-field cron: `minute hour day-of-month month day-of-week`
- Compute `next_fire_at` from current time + cron expression
- Evaluate using the runtime-level timezone from config (all storage in UTC)
- Also support `once` triggers: `next_fire_at` = the specified ISO 8601 timestamp
- `event` triggers: deferred to future (no `next_fire_at`, fires on event match)

### Task 5.3: Schedule Primitive Handler
- Implement all 5 operations:
  ```typescript
  // schedule({ operation: "create", workflow: "water-reminder", instruction: "Ask if I drank water", trigger: { type: "cron", cron: "0 */2 * * *" } })
  // schedule({ operation: "get", id: "uuid" })
  // schedule({ operation: "list", workflow: "water-reminder" })
  // schedule({ operation: "update", id: "uuid", instruction: "new instruction" })
  // schedule({ operation: "delete", id: "uuid" })       — single delete
  // schedule({ operation: "delete", group: "morning" })  — batch delete
  ```
- `create`: validate trigger config → compute next_fire_at → insert → return schedule object with ID
- `get`: lookup by ID → return full schedule object
- `list`: query with filters (workflow, group, status, trigger_type) → return array
- `update`: modify fields → recompute next_fire_at if trigger changed → return updated object
- `delete`: remove by ID or by group → return count deleted

### Task 5.4: Scheduler Tick Loop
- Integrate into the core loop (runs every 5 seconds):
  ```
  Every 5 seconds:
    → Query: SELECT * FROM schedules WHERE status = 'active' AND next_fire_at <= now()
    → For each due schedule:
      → Set last_fire_at = now()
      → If trigger_type = 'once': set status = 'completed'
      → If trigger_type = 'cron': compute and set next next_fire_at
      → Create a triggered session with the schedule's instruction
  ```
- On startup: run catch-up check. For any schedule where `next_fire_at` is in the past, fire once and recompute. Do NOT replay every missed tick.

### Task 5.5: Triggered Sessions
- When a schedule fires, create a new session:
  - Session type: `triggered` (vs `interactive`)
  - System prompt includes schedule context: workflow, instruction, schedule ID
  - No initial user message — the instruction IS the prompt
  - Full 7-primitive access (same as interactive sessions)
  - Session runs to completion (model's final response with no pending tool calls)
  - Maximum 50 iterations (same as interactive)
- Triggered sessions run concurrently with interactive sessions
- If triggered session uses `interact`:
  - `notify`: fire and forget (no response needed)
  - `ask`/`approve`: 2-minute timeout from delivery. On timeout, return timeout indicator. Session decides what to do.

### Task 5.6: Schedule Lifecycle Edge Cases
- Concurrent triggers: two schedules fire at the same time → two independent sessions
- Trigger during active user session: triggered session runs in parallel, does not interfere
- Failed execution: set `last_fire_status = 'failed'`, do NOT auto-retry
- Schedule CRUD during active session: the model can create/modify/delete schedules while conversing with the user

---

## Definition of Done

1. Agent can create a schedule: "Remind me to drink water every 2 hours"
2. Schedule fires on time — a triggered session runs and sends a notification
3. Agent can list, update, and delete schedules
4. Batch delete by group works
5. Daemon restart catches up on missed triggers (fires once, not replay all)
6. `once` triggers fire and set status to `completed`
7. `cron` triggers fire and recompute next occurrence
8. Triggered sessions have full primitive access (can read memory, call APIs, etc.)
9. Triggered session `interact` times out after 2 minutes

## Testing Approach

### Unit Tests
- **Cron parser:** Test various cron expressions → verify next_fire_at computation. Edge cases: midnight rollover, month boundaries, leap years.
- **Schedule handler:** Test each CRUD operation. Batch delete. Filter queries.
- **Scheduler tick:** Mock the clock → advance time → verify schedules fire at correct times. Test catch-up on startup with past next_fire_at.

### Integration Tests
- Create a schedule with a 10-second cron → wait 15 seconds → verify triggered session ran and produced output
- Create a `once` schedule 5 seconds in the future → verify it fires and status changes to `completed`
- Create a schedule that uses `interact(notify)` → verify notification appears on WebSocket client
- Kill daemon → wait past a schedule's fire time → restart → verify catch-up fires once

### Test Commands
```bash
bun test src/primitives/schedule/ # schedule handler tests
bun test src/scheduler/           # tick loop + cron parser tests
bun test --integration            # integration with real timers
```
