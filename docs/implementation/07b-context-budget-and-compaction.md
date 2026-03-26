# Slice 07b: Context Budget and Compaction

> **Goal:** Keep long-running sessions inside model context limits by tracking approximate budget usage, compacting older history, and storing durable summaries for later reuse.

**Prerequisites:** Slices 01-06 and 07a.

**Architecture references:** docs/architecture.md — LLM Interface, Memory System Design

---

## What This Slice Delivers

1. Per-session context budget estimates tied to `llm.context_limit`.
2. A 75% compaction trigger and a 90% hard ceiling.
3. Compaction through the same provider adapter used for normal turns.
4. Persisted summary artifacts that later slices can query through the current memory store.

---

## Key Tasks

### Task 07b.1: Add Per-Session Budget Accounting
- Use the existing configured context limit from `src/config/loader.ts` / `src/config/schema.ts`.
- Track rough token estimates for:
  - system prompt
  - tool declarations
  - accumulated user / assistant / tool-result messages
- Apply the same accounting to both interactive and triggered sessions.

### Task 07b.2: Trigger Compaction Before LLM Calls
- Before each provider call in `src/runtime/agent.ts`, check budget utilization.
- Trigger compaction at 75% utilization.
- Keep a recent window of messages: last 6-10 messages, or everything after the most recent user message, whichever is larger.
- Summarize older material through the normal LLM adapter instead of inventing a special summarizer path.

### Task 07b.3: Persist Durable Summary Artifacts
- Replace the compacted history span with a single system summary message.
- Store the summary using the current keyed memory model rather than a new schema. Use a durable null-domain key convention such as `session_summary:{ISO timestamp}` so 07c can query it later.
- Recalculate budget after compaction.
- If utilization is still above 90%, store a final summary and end the session gracefully with a clear notice.

### Task 07b.4: Add Long-Session Regression Coverage
- Cover at least:
  - budget estimation and utilization thresholds
  - compaction replacing older history with a summary
  - summary persistence in memory
  - the 90% hard-ceiling path

---

## Definition of Done

1. Session budget is tracked and checked before every provider call.
2. Long sessions compact at 75% and continue with a reduced history window.
3. Compaction summaries are stored with an agreed key pattern and can be found through the existing memory store.
4. Sessions that remain above 90% after compaction end cleanly with a stored summary.
5. Interactive and triggered sessions share the same budget/compaction rules.

---

## Why It Is Ordered Here / Dependency Note

- This slice follows 07a so long triggered runs are not debugged on top of a known schedule-fire defect.
- It comes before 07c because the persisted summaries produced here become the main continuity artifact consumed there.
