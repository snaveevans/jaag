# Critic Review: uncommitted changes affecting LLM/operator effectiveness

**Date**: 2026-03-21
**Scope**: uncommitted changes
**Reviewer**: AI Critic Agent

---

## Executive Summary

The uncommitted scheduling and interaction work is directionally good, but the current operator-facing seam is still too brittle for reliable LLM use. The biggest problems are not core scheduler correctness; they are interaction transport semantics, schema/handler drift, and capability docs that tell conflicting stories. In practice, the model can still waste turns on schema-valid but handler-invalid schedule calls, background prompts can steal unrelated user input, and queued prompts can time out before anyone sees them. This is not ready to merge as a polished LLM-facing surface until the prompt/reply contract is tightened and the public capability story is made consistent.

---

## Verdict

- **Spec**: Partially met
- **Architecture**: Minor drift
- **Completion**: Incomplete
- **Merge Recommendation**: Fix major issues first

---

## Critical Issues

No critical issues found.

---

## Major Issues

### Schedule schema still underspecifies the real handler contract

- **Location**: `src/primitives/types.ts:148`, `src/primitives/schedule.ts:135`, `src/primitives/schedule.ts:145`, `src/primitives/schedule.ts:232`
- **Problem**: The tool declaration only requires `operation`, while the handler actually requires different fields per operation (`workflow` + `trigger` + instruction/context for `create`, `schedule_id`/`id` for `get` and `update`, `id XOR group` for `delete`, and at least one mutable field for `update`). That means the model can emit schema-valid calls that are guaranteed to fail at runtime, wasting turns on avoidable repair loops. The declaration also does not tell the model that `workflow` is just a label while `instruction`/`context.instruction` is the executable task.
- **Recommendation**: **Fix now.** Encode per-operation requirements in the declaration with `oneOf`/conditional schemas if the provider supports them; otherwise expand the schedule tool description to spell out each operation's required fields and the `workflow` vs `instruction` distinction explicitly.

### Prompt replies are uncorrelated and can consume the wrong user message

- **Location**: `src/communication/adapter.ts:14`, `src/communication/websocket.ts:13`, `src/communication/websocket.ts:73`, `src/runtime/agent.ts:87`, `src/runtime/agent.ts:400`
- **Problem**: While any `ask`/`approve` prompt is pending, the next inbound websocket message is blindly treated as that prompt's answer. Inbound messages carry no `sessionId`, prompt id, or reply correlation field, so a normal user command can be hijacked as the answer to a background schedule prompt or policy approval.
- **Recommendation**: **Fix now.** Add prompt correlation to the wire protocol (`prompt_id` or `reply_to_session_id`) and only resolve the matching pending prompt. If an inbound message does not match a pending prompt, route it through the normal interactive queue instead of consuming it as a reply.

### Prompt timeouts start even when the prompt was never delivered

- **Location**: `src/runtime/agent.ts:463`, `src/runtime/agent.ts:475`, `src/communication/websocket.ts:124`
- **Problem**: The runtime starts the timeout as soon as a queued prompt becomes active, before it knows whether the message actually reached a connected client. `adapter.send(...)` returns `{ delivered: false }` when disconnected, but the runtime ignores that delivery result and keeps the timer running. Scheduled prompts with a 2-minute timeout can therefore expire before the operator reconnects and sees anything.
- **Recommendation**: **Fix now.** Do not start the timer until delivery is confirmed, or pause/restart the timer based on connection state and actual delivery. At minimum, if `delivered === false`, keep the prompt queued but mark it as not yet timing out.

### Approval semantics are lossy and mislabel ambiguous replies as denials

- **Location**: `src/runtime/agent.ts:342`, `src/runtime/agent.ts:356`, `src/runtime/agent.ts:591`, `src/policy/engine.ts:154`, `src/runtime/system-prompt.ts:41`, `src/primitives/types.ts:259`
- **Problem**: Approval parsing accepts only a narrow yes/no vocabulary, but the model is not told to ask for strict yes/no responses. Anything outside that small set silently becomes `approved: false`, and policy enforcement then reports `User denied: ...` even when the operator actually sent a clarification, a natural-language approval like "send it", or a malformed client action.
- **Recommendation**: **Fix now.** Update the prompt/tool description so approval requests explicitly instruct `Reply yes or no only`, and change the runtime to distinguish `denied` from `unrecognized`. Return a structured ambiguous result (for example `approved: null`, `rawResponse`) or a validation error instead of silently converting ambiguous text into a denial.

### The shipped manual client cannot actually test the new interaction model

- **Location**: `src/manual/websocket-client.ts:4`, `src/manual/websocket-client.ts:17`, `src/manual/websocket-client.ts:90`, `README.md:84`
- **Problem**: `bun run manual:ws` is presented as the manual testing path, but it sends one initial prompt, never reads stdin for follow-up replies, and auto-closes after 1500 ms idle by default. That makes `interact.ask`, `interact.approve`, and most scheduled-session debugging effectively impossible with the built-in client.
- **Recommendation**: **Fix now.** Keep the socket open and read stdin for subsequent replies, or clearly relabel this helper as a one-shot stream viewer and add a separate interactive client for `ask`/`approve` flows.

### Public docs still tell conflicting stories about scheduling support

- **Location**: `README.md:18`, `README.md:121`, `docs/implementation/05-scheduling.md:14`, `docs/architecture.md:655`
- **Problem**: The README still says only Slice 01 is complete and describes `schedule` as time-and-event based; the Slice 05 plan also speaks as if event triggers are part of the delivered primitive; the architecture doc now says event scheduling is deferred to v0.2. That leaves no single trustworthy capability statement for operators or future models.
- **Recommendation**: **Fix now.** Update README and scheduling docs to say the shipped surface is `cron` + `once`, while `event` remains deferred. Also update the project status table so operators do not assume scheduling is still unavailable.

---

## Minor Issues

### Missing schedules still come back as successful mutations

- **Location**: `src/primitives/schedule.ts:80`, `src/primitives/schedule.ts:102`
- **Problem**: `update` and `delete` return `success: true` even when the target schedule does not exist (`schedule: null` or `deleted: false`). Many tool-using models overweight the top-level success bit and can falsely conclude that the mutation succeeded.
- **Recommendation**: **Fix now** for `update`/`delete` if possible; otherwise **document for later** that schedule misses are soft misses. Prefer returning `success: false` with an explicit not-found error for mutations.

### Some repair-path errors still hide the bad parameter name

- **Location**: `src/primitives/schedule.ts:258`, `src/primitives/dispatcher.ts:444`
- **Problem**: Helper paths still emit generic messages such as `Invalid string: expected a non-empty string.` or `Expected optional string parameter to be a non-empty string.` without naming the offending field. That slows model self-repair because it has to guess which argument was wrong.
- **Recommendation**: **Document for later** if you need to ship, but the better fix is small: thread field names through the optional-string helpers so runtime errors always identify the bad argument.

---

## Strengths

- The new schedule store/service coverage is focused on real operational cases: cron catch-up, once completion, timezone handling, and preserving due cron runs during metadata-only updates (`src/scheduler/store.test.ts:15`, `src/scheduler/service.test.ts:17`, `src/scheduler/cron.test.ts:31`).
- Triggered sessions correctly reuse the normal agent loop instead of inventing a second execution path, which matches the architecture and reduces fake-complete scheduling behavior (`src/runtime/agent.ts:116`, `src/session/manager.ts:53`, `src/runtime/system-prompt.ts:28`).
- The interaction queue fix removes the immediate overlapping-prompt failure and is covered by runtime tests, so the code is moving in the right direction even though the transport seam still needs tightening (`pitfalls.md:5`, `src/runtime/agent.test.ts:1040`).

---

## Review Notes

- No formal ticket or ADR defined success for this uncommitted state, so this review used the user request as the primary spec and cross-checked against `docs/architecture.md`, `docs/implementation/05-scheduling.md`, and the runtime surface exposed in `src/primitives/types.ts`.
- I ran `bun test src/primitives/schedule.test.ts src/runtime/agent.test.ts src/db/database.test.ts src/config/loader.test.ts` and `bun run typecheck`; both passed. The findings above are therefore polish/contract problems that survive green tests, not basic breakages.
- I did not flag missing event-trigger implementation by itself as a bug; I flagged the split public story and partial surfacing around it because that is what will waste operator/model cycles in practice.
