# Slice 07: Hardening

> **Goal:** Make the agent production-ready for daily personal use. Context budget management, crash recovery, structured logging, and all the edge cases that don't fit neatly into a single primitive.

**Prerequisites:** All previous slices (01-06)

**Architecture references:** docs/architecture.md — LLM Interface (context budget), State Management (compaction summaries), Process Model (crash recovery)

---

## What This Slice Delivers

1. Context budget tracking and compaction (75% threshold)
2. Compaction summaries stored in memory
3. Structured JSON logging with audit trail
4. Crash recovery (stale PID detection, SQLite integrity)
5. Graceful degradation (LLM API down, SQLite locked, WebSocket disconnected)
6. Full error handling pass across all primitives

---

## Tasks

### Task 7.1: Context Budget Tracking
- Track approximate token usage per session:
  ```typescript
  interface ContextBudget {
    limit: number              // from config (context_limit)
    systemPromptTokens: number // estimated once at session start
    functionDeclTokens: number // estimated once at session start
    messageTokens: number      // updated each turn
    utilization(): number      // returns 0.0 - 1.0
  }
  ```
- Estimation: 4 characters ≈ 1 token (rough but directionally correct)
- Update `messageTokens` after each message append (user, assistant, tool result)
- Check utilization before each LLM call

### Task 7.2: Compaction
- Trigger at 75% utilization:
  ```
  1. Split message history: keep recent messages (last 6-10, or everything after
     most recent user message — whichever is larger), compact everything older
  2. Build summarization prompt:
     "Summarize the conversation so far. Preserve:
      - Current task state and what the user asked for
      - Key decisions made and their reasoning
      - Facts learned about the user (preferences, context)
      - Any pending actions or commitments
      - Tool results that are still relevant"
  3. Send to LLM → receive summary
  4. Replace compacted messages with single summary message (role: system)
  5. Store summary in memory:
     key: "session_summary:{ISO timestamp}"
     domain: null
  6. Update context budget estimate
  ```
- Hard ceiling: 90% after compaction → end session with notice, store summary
- The compaction LLM call uses the same provider adapter as normal turns

### Task 7.3: Structured Logging
- Replace console.log with structured JSON logging:
  ```typescript
  interface LogEntry {
    timestamp: string       // ISO 8601
    level: 'debug' | 'info' | 'warn' | 'error'
    component: string       // 'session', 'policy', 'interpreter', 'scheduler', etc.
    event: string           // 'primitive_call', 'policy_decision', 'session_start', etc.
    sessionId?: string
    data?: Record<string, any>  // event-specific data
  }
  ```
- Log to `~/.agent/logs/agent.log` (append mode)
- Key events to log:
  - Session start/end (with type: interactive/triggered)
  - Every primitive call (primitive name, params summary, result summary)
  - Every policy decision (rule matched, action taken, approval result)
  - LLM calls (model, token estimate, tool calls requested)
  - Schedule fires
  - Errors (with stack traces)
- Log rotation: deferred (out of scope for v0.1 — the user can set up logrotate externally)

### Task 7.4: Crash Recovery
- **Stale PID detection:** On startup, if PID file exists, check if process is actually running (`kill -0 pid`). If not running → stale PID → remove and continue. If running → abort with "already running" error.
- **SQLite integrity:** On startup, run `PRAGMA integrity_check` on the database. If corrupt → log error, attempt to recover (or start fresh with warning).
- **Incomplete state cleanup:** On startup, set any schedules with `last_fire_status = 'running'` to `'failed'` (they were interrupted by the crash).

### Task 7.5: Graceful Degradation
- **LLM API unreachable:**
  - Interactive session: return error to user "Cannot reach LLM API. Check your connection and API key."
  - Triggered session: set fire status to 'failed', log error, end session
  - Do not crash the daemon
- **SQLite locked:**
  - Retry with exponential backoff (WAL mode should prevent most contention)
  - After 3 retries: log error, return primitive failure
- **WebSocket disconnected:**
  - Buffer outbound messages (up to 100 messages or 1MB)
  - On reconnect: deliver buffered messages in order
  - If buffer full: drop oldest messages, log warning
- **Tool spec API errors:** Already handled by interpreter (Slice 03), but verify all error paths produce actionable model feedback

### Task 7.6: Error Handling Audit
- Review every primitive handler for unhandled error cases:
  - `memory`: SQLite write failures, FTS5 index corruption
  - `file_read`/`file_write`: permission denied, disk full, symbolic links, race conditions
  - `http`/interpreter: malformed specs, invalid URLs, DNS failures, TLS errors, response parsing failures
  - `execute`: command not found, working directory missing, pipe errors
  - `schedule`: invalid cron expressions, duplicate IDs
  - `interact`: adapter failures, timeout edge cases
- Every error should produce a `PrimitiveResult` with `success: false` and a helpful error message. No unhandled promise rejections. No crashes from bad model input.

### Task 7.7: Session Startup Memory Loading
- On interactive session start, load relevant context from memory:
  - Query memory for recent session summaries (last 3-5)
  - Query memory for user preferences (domain: null)
  - Include a brief context block in the system prompt: "Here's what I know from our previous conversations: ..."
- This gives the agent continuity without requiring the user to re-explain context

---

## Definition of Done

1. Long conversations trigger compaction at 75% — session continues smoothly with reduced history
2. Compaction summaries appear in memory and are found by future sessions
3. 90% hard ceiling ends session gracefully with a stored summary
4. Structured logs capture all primitive calls and policy decisions
5. Killing the daemon and restarting recovers cleanly (stale PID, incomplete schedules)
6. LLM API being down does not crash the daemon
7. No unhandled errors from any primitive — every failure path returns a clean result
8. New sessions start with context from previous conversations (via memory)

## Testing Approach

### Unit Tests
- **Context budget:** Test estimation accuracy on known strings. Test utilization calculation.
- **Compaction:** Mock LLM to return a canned summary → verify message history is replaced → verify summary stored in memory → verify budget recalculated.
- **Crash recovery:** Create stale PID file → verify cleanup on startup. Create "running" schedule entries → verify reset to "failed".
- **Graceful degradation:** Mock LLM timeout → verify error message returned (not crash). Mock SQLite lock → verify retry then failure.

### Integration Tests
- Have a long conversation (or simulate one) that approaches 75% budget → verify compaction fires → continue conversation → verify coherence
- Kill daemon mid-operation → restart → verify clean recovery
- Disconnect WebSocket client → send messages from triggered session → reconnect → verify buffered messages delivered

### Test Commands
```bash
bun test src/context/             # context budget + compaction tests
bun test src/logging/             # logging tests
bun test --integration            # full integration tests
```
