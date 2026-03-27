# Pitfalls (errors + fixes)

This file is a running log of small-but-annoying issues we've hit, plus the fix that worked.

## 2026-03-25 - Async session bootstrap refactors require updating both local vars and sync test call sites

### Symptom

- While making `SessionManager` support async system-prompt building, the first typecheck pass failed because `src/session/manager.ts` referenced `now` inside a helper where only `input.now` existed.
- Related tests and runtime subclasses also broke until all `getOrCreateInteractiveSession(...)` / `createTriggeredSession(...)` call sites were updated to `await` the new Promise-based API.

### Cause

- The refactor moved prompt construction into an async helper but left behind one stale variable reference from the old synchronous implementation.
- The API shape changed from sync to async, but several tests and one subclass still assumed immediate `AgentSession` returns.

### Fix

- In `src/session/manager.ts`, pass `now: input.now` through the async helper instead of referencing a non-existent local variable.
- Update all affected callers and overrides to `await` the async session methods, including `src/runtime/agent.ts`, `src/session/session.test.ts`, and `src/runtime/agent.test.ts`.

### How to avoid next time

- When lifting sync construction into an async helper, do a quick pass for stale locals copied from the old scope before running typecheck.
- After changing a manager API from sync to async, grep every call site and test override immediately instead of relying on incremental compile errors.

### Evidence (optional)

- Validation after the fix: `bun run typecheck`; `bun test`

## 2026-03-25 - Compaction budget guards need realistic minimum context limits in hard-ceiling tests

### Symptom

- A follow-up Slice 07b runtime patch added a pre-check for the compaction-summary provider call, then `bun test src/runtime/agent.test.ts` failed twice because the existing hard-ceiling compaction tests stopped seeing any summary call (`Expected: 1, Received: 0`).

### Cause

- The helper that searched for a matching `contextLimit` started at `1`, which let the hard-ceiling tests pick an unrealistically tiny limit even though the intended path was "compaction is attempted, then the session still ends above 90%."
- Once the runtime became budget-aware about the compaction request itself, those tiny limits correctly skipped the summary call, so the old test setup no longer matched the scenario it claimed to cover.

### Fix

- Keep the runtime guard aligned to the existing hard-ceiling heuristic (`> 90%` means unsafe for the compaction request).
- In `src/runtime/agent.test.ts`, update the hard-ceiling context-limit helper call sites to pass a realistic `minimumContextLimit` derived from the compaction-request token estimate.
- Leave a separate regression for the truly-too-large compaction-request path instead of overloading the existing happy-path hard-ceiling tests.

### How to avoid next time

- When adding budget-aware guards around a provider sub-call, re-check any tests that derive synthetic limits with brute-force helper loops; they may accidentally rely on impossible limits.
- For compaction-path tests, make the chosen `contextLimit` satisfy both the outer session condition and the inner compaction-request condition.

### Evidence (optional)

- Validation after the fix: `bun test src/runtime/agent.test.ts`; `bun test`; `bun run typecheck`

## 2026-03-25 - Compaction heuristic tests should use explicit window math and simple expectations

### Symptom

- A first-pass Slice 07b test patch failed `bun run typecheck` because one new expectation had an extra closing parenthesis and another used a contrived string expression for an expected role literal.
- The follow-up `bun test` run still failed because the new compaction heuristic test expected `keepStartIndex` 4 when the implemented "keep the larger of the last N messages or the latest user exchange" rule correctly produced 5.

### Cause

- I hand-authored a long expectation chain without simplifying it first, which made a small punctuation mistake easy to miss.
- I also miscounted the kept trailing window when converting the documented heuristic into a concrete assertion.

### Fix

- Replace clever/string-generated expected values with direct literals in `src/context/budget.test.ts`.
- Fix the malformed expectation in `src/runtime/agent.test.ts`.
- Recalculate the expected compaction window explicitly: with 11 total messages and a keep window of 6, the last-window start index is 5, so messages before that index are the compacted span.

### How to avoid next time

- For heuristic tests, write out the concrete index math from the current fixture before locking the assertion.
- Keep expected-role arrays and boolean assertions literal and boring; avoid clever expressions in test expectations.
- When a large patch adds multiple new tests, run `bun run typecheck` before the full suite so syntax mistakes surface faster.

### Evidence (optional)

- Validation after the fix: `bun run typecheck`; `bun test`

## 2026-03-25 - Verify numbered implementation doc filenames before reading adjacent slices

### Symptom

- While splitting `docs/implementation/07-hardening.md`, a read against `docs/implementation/06-reliability.md` failed with `File not found`.

### Cause

- I inferred the neighboring slice filename from the topic instead of verifying the actual filenames in `docs/implementation/`.

### Fix

- Run a file-name check first (`glob` over `docs/implementation/*.md`) and then read the actual adjacent docs that exist.
- In this repo, the correct nearby references were `docs/implementation/05-scheduling.md` and `docs/implementation/06-execute.md`.

### How to avoid next time

- When a repo uses numbered slice docs, verify the exact filenames before reading “the previous slice” by guessed name.
- Prefer a quick glob over assuming that topic names line up with slice numbers.

### Evidence (optional)

- Error observed while preparing the Slice 07 doc split; resolved by checking `docs/implementation/*.md` and switching to the real filenames.

## 2026-03-25 - OpenAI-compatible tool-call turns must not send empty assistant content

### Symptom

- A follow-up request after a scheduled run that called `interact(mode: notify)` failed against MiniMax with `400 invalid params, chat content is empty`.

### Cause

- `src/llm/openai.ts` serialized assistant messages that contained tool calls but no text as `content: ""`.
- Some OpenAI-compatible providers reject empty-string assistant content on tool-call turns.

### Fix

- Normalize assistant tool-call messages with empty text to `content: null` instead of `""` in `src/llm/openai.ts`.
- Add a regression test in `src/llm/openai.test.ts` that captures the outgoing request body and asserts the tool-call assistant message no longer sends empty-string content.

### How to avoid next time

- When translating to provider-specific chat payloads, treat empty assistant content on tool-call turns as nullable/omittable metadata, not as a literal empty string.
- Keep request-body regression tests around provider-compatibility quirks at the serialization boundary.

### Evidence (optional)

- Validation: `bun test src/llm/openai.test.ts --test-name-pattern "serializes assistant tool-call messages without empty string content"`; `bun test src/llm/openai.test.ts`; `bun test`; `bun run typecheck`

## 2026-03-21 - Concurrent prompts need a queue, and cron metadata updates must not retime schedules

### Symptom

- Concurrent triggered sessions that both called `interact` could fail the second run with `Another user prompt is already waiting for a response.` instead of waiting for the first prompt to finish.
- Updating only cron schedule metadata could recompute `next_fire_at` from `now`, which could skip a run that was already due.

### Cause

- `src/runtime/agent.ts` only tracked one in-flight prompt and rejected every overlapping request immediately.
- `src/scheduler/store.ts` always recomputed active cron timing during updates, even when the trigger and status semantics had not changed.

### Fix

- Queue prompt requests globally, activate them one at a time, and start the reply timeout only when a prompt becomes active.
- Preserve `next_fire_at` when an update keeps the same trigger timing and status, and recompute only when the trigger or status transition changes scheduling semantics.
- Updated files: `src/runtime/agent.ts`, `src/runtime/agent.test.ts`, `src/scheduler/store.ts`, `src/scheduler/store.test.ts`

### How to avoid next time

- When transport only supports one uncorrelated reply at a time, serialize prompt requests instead of failing overlapping background work.
- Treat schedule metadata edits separately from timing edits so due work is not silently pushed forward.

### Evidence (optional)

- Validation: `bun test src/runtime/agent.test.ts src/scheduler/store.test.ts`; `bun test`; `bun run typecheck`

## 2026-03-21 - Symlink-aware path checks and prompt state must be installed before async sends

### Symptom

- File-write policy checks allowed writes that escaped the workspace through symlinked ancestors, and protected runtime paths could be reached through symlink aliases.
- Interactive prompts could hang when an adapter produced a reply during `send(...)` before the runtime finished registering the pending request.

### Cause

- File safety checks compared lexical paths instead of the effective filesystem target after resolving symlinked ancestors.
- `src/runtime/agent.ts` awaited the outbound send before storing the pending prompt resolver, so a fast inbound reply hit the normal queue instead of the prompt waiter.

### Fix

- Resolve file targets against the real filesystem path, walking up to the nearest existing ancestor for yet-to-be-created files, and use that effective target for both protected-path checks and file policy matching.
- Create the pending prompt request before calling `adapter.send(...)`, then clear or reject it only if the send fails before a response arrives.
- Updated files: `src/primitives/file.ts`, `src/primitives/dispatcher.ts`, `src/policy/engine.ts`, `src/runtime/agent.ts`, `src/primitives/file.test.ts`, `src/primitives/dispatcher.test.ts`, `src/policy/engine.test.ts`, `src/runtime/agent.test.ts`

### How to avoid next time

- For any security-sensitive file allowlist or blocklist, compare canonical effective targets, not just normalized strings.
- When waiting for an async reply, install the pending state before the outbound operation that can trigger the reply.

### Evidence (optional)

- Validation: `bun test src/primitives/file.test.ts src/primitives/dispatcher.test.ts src/policy/engine.test.ts src/runtime/agent.test.ts`; `bun test`; `bun run typecheck`

## 2026-03-21 - Strict TS dislikes mixed nullish/or chains and overly-wide helper returns

### Symptom

- `bun run typecheck` failed during Slice 02 with `?? and || operations cannot be mixed without parentheses` in path resolution code.
- The same pass also failed when a domain parser returned `string | null | undefined` but a memory helper required `string | null`.

### Cause

- TypeScript treats mixed `??` / `||` expressions as ambiguous unless they are parenthesized or simplified.
- Reusing one parser for both "scoped domain" and "optional filter" cases widened the return type beyond what keyed memory operations accepted.

### Fix

- Replace the mixed fallback expression with a single nullish chain in `src/primitives/file.ts`.
- Add a dedicated `parseScopedDomain()` wrapper in `src/primitives/memory.ts` so keyed operations always receive `string | null`.

### How to avoid next time

- In strict TypeScript, do not mix `??` with `||` in one expression; pick one operator family or add explicit grouping.
- When one helper serves both optional-filter and required-scoped cases, add a narrow wrapper instead of pushing a wider union through every call site.

### Evidence (optional)

- Fixed files: `src/primitives/file.ts`, `src/primitives/memory.ts`
- Validation: `bun run typecheck`

## 2026-03-20 - Bun CLI helpers should use process.exit and close codes

### Symptom

- `bun run typecheck` reported `Property 'exit' does not exist on type 'typeof import("bun")'` in a manual WebSocket helper.
- The helper also exited with code 1 after a normal `1000` WebSocket close because `CloseEvent.wasClean` was not reliable in this path.

### Cause

- Bun exposes process exit through Node's `process.exit(...)`, not `Bun.exit(...)`.
- For this client helper, `event.code === 1000` was a more dependable success signal than `event.wasClean`.

### Fix

- Replace `Bun.exit(...)` with `process.exit(...)` in `src/manual/websocket-client.ts`.
- Treat WebSocket close code `1000` as success when deciding the helper's exit code in `src/manual/websocket-client.ts`.

### How to avoid next time

- In repo-local Bun CLI scripts, prefer `process.exit(...)` unless Bun's API docs explicitly expose an alternative.
- When validating a Bun WebSocket client helper, smoke-test the actual close path instead of assuming `wasClean` behaves like a browser client.

### Evidence (optional)

- Fixed file: `src/manual/websocket-client.ts`
- Validation: `bun run typecheck`; `AGENT_WS_URL=ws://127.0.0.1:9876 bun run manual:ws "smoke test"`

## 2026-03-19 - Bun WebSocket and OpenAI types need explicit narrowing

### Symptom

`bun run typecheck` failed with Bun WebSocket typing errors around `ServerWebSocket` / `server.upgrade()` and strict-cast errors when passing translated message and tool arrays into the OpenAI chat completions client.

### Cause

`Bun.serve()` inferred a websocket data type that made `server.upgrade()` expect explicit `data`, and the OpenAI SDK types are stricter than a generic `Record<string, unknown>[]` translation layer.

### Fix

- Set the websocket server type explicitly with `Bun.serve<undefined>(...)` and use `ServerWebSocket<undefined>` in `src/communication/websocket.ts`.
- Keep the translation helpers generic, then cast through `unknown` when handing the final arrays to the OpenAI SDK in `src/llm/openai.ts`.
- Provide a real fallback prompt builder in `src/session/manager.ts` so strict mode does not allow an undefined callback.

### How to avoid next time

- When using Bun WebSockets under strict TypeScript, decide the websocket `data` type up front instead of relying on inference.
- When an SDK expects a provider-specific union type, translate internally however you want but cast only at the boundary, not throughout the code.
- Re-run `bun run typecheck` after any Bun server or SDK boundary changes.

### Evidence (optional)

- Fixed files: `src/communication/websocket.ts`, `src/llm/openai.ts`, `src/session/manager.ts`
- Validation: `bun run typecheck`
