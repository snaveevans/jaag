# LLM/Runtime Polish Backlog

This file tracks confirmed LLM/runtime polish debt from the 2026-03-21 scan and follow-up code review. Append future confirmed polish debt here instead of creating one-off notes elsewhere.

Primary scan source: `reviews/critic-review.md`.

## Priority Guide

- `P0`: breaks the operator/LLM contract or can route the wrong input, lose a prompt, or misstate approval state
- `P1`: high-friction contract, tooling, or documentation drift that wastes turns or misleads operators
- `P2`: meaningful polish that still causes repair loops, false positives, or confusing UX

## Backlog

### Resolved 2026-03-22 - P0 interaction-contract polish shipped

- Prompt/reply correlation now uses prompt ids on outbound ask/approve messages plus inbound `replyToPromptId` / `reply_to_prompt_id`, with a one-active-prompt fallback for legacy replies that omit the id.
- Prompt timeout budgets are now delivery-aware: queued or undelivered prompts do not start burning timeout until transport delivery is confirmed.
- Approval handling is now tri-state: explicit yes/no stays boolean, ambiguous replies surface `approved: null` with the raw reply/error, and policy messaging distinguishes ambiguous approval from explicit denial.
- Manual websocket testing now supports correlated follow-up replies over stdin.
- Key refs: `src/communication/adapter.ts`, `src/communication/websocket.ts`, `src/runtime/agent.ts`, `src/policy/engine.ts`, `src/manual/websocket-client.ts`

### P1 - Make the `schedule` declaration match the real handler contract

- Problem: The declaration mostly exposes `operation` plus a flat bag of optional fields, while the handler has per-operation requirements, update-only rules, aliases, and runtime-only behavior around `workflow`, `instruction`, `schedule_id` or `id`, and `id` vs `group`.
- Why it matters: The model can emit schema-valid schedule calls that are guaranteed to fail at runtime, wasting turns and making the tool feel unreliable.
- Suggested follow-up: Encode per-operation requirements if provider tooling allows it; otherwise expand the declaration text and reduce alias or conditional ambiguity so the model sees the actual contract.
- Key refs: `src/primitives/types.ts`, `src/primitives/types.test.ts`, `src/primitives/schedule.ts`, `reviews/critic-review.md`

### P1 - Refresh or restate tool-manifest guidance after in-session tool registration

- Problem: Tool declarations update after `spec.register`, but the system prompt's installed-tool manifest is frozen when the session is created.
- Why it matters: A session can hold stale guidance about what is installed even while the provider now receives new callable tools, which creates contradictory context within the same conversation.
- Suggested follow-up: After successful registration, refresh session system guidance or inject a system/tool result note that tells the model to rediscover the tool surface (for example via `spec.list`).
- Key refs: `src/index.ts`, `src/session/manager.ts`, `src/session/session.ts`, `src/system-tools/register.ts`, `src/runtime/agent.ts`

### P1 - Revisit the manual websocket client's short default idle timeout

- Problem: `bun run manual:ws` now supports correlated follow-up replies and additional stdin messages, but it still auto-closes after a short idle window by default (`AGENT_WS_IDLE_MS`, default 1500ms).
- Why it matters: Multi-turn manual debugging still gets interrupted if the operator pauses between replies, which adds friction when reproducing slower `interact.ask`/`interact.approve` or scheduled-session issues.
- Suggested follow-up: Raise or disable the default idle timeout for interactive use, and/or document `AGENT_WS_IDLE_MS=0` as the persistent manual-debug mode.
- Key refs: `src/manual/websocket-client.ts`, `README.md`, `src/communication/websocket.ts`

### P1 - Align public docs with what is actually shipped vs deferred

- Problem: Docs still mix the conceptual 7-primitives architecture with the implemented surface: README presents `schedule` as time-and-event based, `execute` as available, and project status as if only Slice 01 exists, while runtime behavior shows `event` scheduling is deferred and `execute` is still stubbed.
- Why it matters: Operators and future models get the wrong capability story, which leads to bad calls, wrong expectations, and noisy bug reports.
- Suggested follow-up: Publish a single shipped-vs-deferred matrix and update README and implementation docs to clearly call out `cron` plus `once` as shipped, `event` deferred, and `execute` not yet implemented.
- Key refs: `README.md`, `docs/architecture.md`, `docs/implementation/05-scheduling.md`, `docs/implementation/06-execute.md`, `src/primitives/dispatcher.ts`, `src/primitives/schedule.ts`

### P2 - Return field-named repair errors everywhere

- Problem: Some helper paths still emit generic validation errors like `Invalid string...` or `Expected optional string parameter...` without naming the offending field.
- Why it matters: The model has to guess which argument to repair, which causes avoidable retry turns.
- Suggested follow-up: Thread field names through shared optional-string and repair helpers so all runtime validation messages point to the bad parameter explicitly.
- Key refs: `src/primitives/schedule.ts`, `src/primitives/dispatcher.ts`

### P2 - Stop treating missing schedule mutations as `success: true`

- Problem: `schedule.update` and `schedule.delete` return `success: true` even when no target schedule exists.
- Why it matters: Tool-using models often overweight the top-level success bit and may conclude the mutation worked when it did not.
- Suggested follow-up: Return `success: false` for not-found mutations, or at minimum add explicit not-found semantics that the model can key off reliably.
- Key refs: `src/primitives/schedule.ts`, `reviews/critic-review.md`

### P2 - Tighten the provider-facing raw `http` declaration and audit remaining primitive/runtime drift

- Problem: The raw `http` primitive is intentionally broad (`additionalProperties: true`, free-form method and body), while other primitives are stricter and `schedule` already demonstrates how declaration/runtime drift wastes turns.
- Why it matters: Broad or inconsistent declarations increase provider variance, make tool selection noisier, and leave too much repair work to runtime errors.
- Suggested follow-up: Audit primitive declarations against runtime validation, starting with raw HTTP; tighten schemas where safe and document when raw HTTP is a last-resort escape hatch instead of the preferred path.
- Key refs: `src/primitives/types.ts`, `src/interpreter/request-builder.ts`, `src/primitives/dispatcher.ts`, `src/primitives/schedule.ts`
