# Pitfalls (errors + fixes)

This file is a running log of small-but-annoying issues we've hit, plus the fix that worked.

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
