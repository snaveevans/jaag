# Slice 03: Tool Spec Interpreter & HTTP Primitive

> **Goal:** The agent can call external APIs via declarative tool specs. This is the centerpiece of the architecture — the model reads a JSON spec and the runtime translates it into real HTTP requests.

**Prerequisites:** Slice 01 (Skeleton), Slice 02 (Memory — needed for auth token storage)

**Architecture references:** docs/architecture.md — Primitive Execution (`http`), Tool Spec Interpreter, System Tools. docs/tool-spec-format.md — full spec reference.

---

## What This Slice Delivers

1. Tool spec loading from filesystem (trusted/user-reviewed/untrusted directories)
2. Function declaration generation from tool spec operations
3. The 6-stage interpreter pipeline (spec resolution → auth injection → request building → HTTP execution → response mapping → error handling)
4. OAuth2 auth middleware (token check → refresh → re-authorize via interact)
5. System tools: `spec.validate`, `spec.register`, `spec.list`, `spec.get`
6. A working end-to-end flow: agent calls `github.issues.list` → runtime reads spec → builds HTTP request → calls GitHub API → returns structured result

---

## Tasks

### Task 3.1: Spec Loading & Registry
- Create spec registry module:
  ```
  src/
    specs/
      registry.ts        # loads specs from disk, tracks trust tiers
      loader.ts          # parse + validate individual spec files
      validator.ts       # spec schema validation
      types.ts           # ToolSpec, Operation, Param, etc. type definitions
  ```
- Scan tool directories on startup:
  - `~/.agent/tools/trusted/*.json` → trust tier: trusted
  - `~/.agent/tools/user-reviewed/*.json` → trust tier: user-reviewed
  - `~/.agent/tools/untrusted/*.json` → trust tier: untrusted
- Parse and validate each spec against the spec schema
- Build in-memory registry: Map<toolId, { spec, trustTier }>

### Task 3.2: Function Declaration Generation
- For each operation in each loaded spec, generate an LLM function declaration:
  ```typescript
  interface ToolDeclaration {
    name: string          // e.g., "gmail_messages_send" (provider-safe naming)
    description: string   // from operation description
    parameters: JSONSchema // generated from operation params + body
  }
  ```
- Handle naming: canonical `gmail.messages.send` → provider-safe `gmail_messages_send`
- Maintain bidirectional mapping: provider name ↔ canonical name ↔ spec + operation
- Merge these declarations with the primitive and system tool declarations at session start

### Task 3.3: The Interpreter Pipeline
- Implement the 6-stage pipeline in:
  ```
  src/
    interpreter/
      pipeline.ts        # orchestrates the 6 stages
      auth.ts            # Stage 2: auth injection
      request-builder.ts # Stage 3: URL + headers + body construction
      response-mapper.ts # Stage 5: response field extraction
      error-handler.ts   # Stage 6: error translation
  ```
- **Stage 1 — Spec Resolution:** Look up spec + operation from the function name. Validate model-provided params against operation schema. Check trust tier.
- **Stage 2 — Auth Injection:** Check memory for stored token (`oauth:{tool_id}:{token_storage_key}`). If valid → attach. If expired → refresh via token endpoint → store new → attach. If missing/refresh fails → trigger `interact(ask)` to guide user through authorization.
- **Stage 3 — Request Building:** Substitute path parameters. Assemble query params. Set headers (connection defaults + operation overrides). Construct body. Combine with `base_url`.
- **Stage 4 — HTTP Execution:** `fetch()` with 30-second timeout. Retry on 429 (Retry-After) and 503 (exponential backoff), max 3 attempts. On 401 → trigger auth refresh, retry once.
- **Stage 5 — Response Mapping:** Extract fields per `operation.response` schema. Filter to only declared fields. Include pagination token if present.
- **Stage 6 — Error Handling:** Translate HTTP errors to actionable model feedback (400 → bad params, 403 → permission denied, 404 → not found, 429 → rate limited, 500+ → server error).

### Task 3.4: Auth Middleware
- OAuth2 token lifecycle:
  ```
  checkToken(toolId, tokenKey)
    → memory.get(domain: toolId, key: "oauth:{toolId}:{tokenKey}")
    → if exists and not expired → return token
    → if exists and expired → refreshToken()
    → if missing → initiateAuth()
  
  refreshToken(toolId, spec)
    → POST to spec.auth.token_url with refresh_token
    → if success → memory.set new token → return token
    → if fails → initiateAuth()
  
  initiateAuth(toolId, spec)
    → interact(mode: ask, message: "I need access to {tool}. 
        Please visit: {auth_url} and paste the authorization code.")
    → receive code from user
    → exchange code for token via token endpoint
    → memory.set token
    → return token
  ```
- Token storage format in memory: `{ access_token, refresh_token, expires_at, scope }`
- Auto-prefix memory keys with `oauth:{tool_id}:` per the architecture

### Task 3.5: System Tools
- Implement the 4 system tools:
  ```
  src/
    system-tools/
      handler.ts         # routes system tool calls
      validate.ts        # spec.validate — check spec against schema, return errors
      register.ts        # spec.register — write spec to untrusted directory, add to registry
      list.ts            # spec.list — return tool manifests
      get.ts             # spec.get — return full spec or specific operation detail
  ```
- `spec.validate(spec)`: validate JSON against spec schema → return validation errors or "valid"
- `spec.register(spec)`: write to `~/.agent/tools/untrusted/{id}.json` → add to in-memory registry → generate new function declarations → return confirmation
- `spec.list()`: return manifest (name, description, operations list for each tool)
- `spec.get(tool, operation?)`: return full spec or single operation detail

### Task 3.6: Dispatch Integration
- Update primitive dispatcher to route `http` calls through the interpreter
- When the model calls a tool spec operation function (e.g., `github_issues_list`), the dispatcher:
  1. Recognizes it as a spec operation (not a raw primitive)
  2. Translates to canonical name (`github.issues.list`)
  3. Routes to the interpreter pipeline
  4. Returns the result
- Raw `http` calls (not via a spec) still work for ad-hoc requests
- Domain auto-prefixing: when the interpreter calls `memory.set` during auth, auto-prefix domain with tool ID

### Task 3.7: Create a Test Tool Spec
- Create a GitHub tool spec for testing (use the one from docs/tool-spec-format.md)
- Place it in `~/.agent/tools/trusted/github.json`
- Include at minimum: `issues.list`, `issues.get`, `issues.create`
- Auth: personal access token (simpler than OAuth2 for testing — header injection, no refresh flow)

---

## Definition of Done

1. Tool specs are loaded from disk on startup, with correct trust tier assignment
2. Tool spec operations appear as callable functions in the LLM's function list
3. Agent can list GitHub issues: "Show me open issues in repo X" → model calls `github_issues_list` → interpreter builds GET request → returns structured issues
4. Agent can create a GitHub issue: "Create an issue titled 'Fix bug'" → model calls `github_issues_create` → interpreter builds POST request → issue created on GitHub
5. System tools work: agent can call `spec.list` to see available tools, `spec.get` to inspect details
6. Agent can create a new tool spec via `spec.register` (stored as untrusted)
7. Auth token storage and retrieval works via memory
8. HTTP errors are translated into clear model-facing messages
9. Retry logic works for 429/503 responses

## Testing Approach

### Unit Tests
- **Spec loader:** Parse valid specs, reject malformed specs, validate all required fields
- **Function declaration generator:** Verify generated declarations match expected schema for each operation
- **Request builder:** Given an operation + params, verify the constructed URL, headers, query params, and body are correct
- **Response mapper:** Given a raw API response + response schema, verify extracted fields
- **Error handler:** Given various HTTP status codes, verify correct error messages
- **Auth middleware:** Mock memory + mock HTTP (for token refresh) → verify the full check → refresh → re-auth flow

### Integration Tests
- Load a GitHub spec → call `issues.list` against real GitHub API (or mock server) → verify structured response
- Register a new spec via `spec.register` → verify file written to untrusted directory → verify new functions available
- Test the full auth flow with a mock OAuth2 server

### Test Commands
```bash
bun test src/specs/               # spec loading/validation tests
bun test src/interpreter/         # interpreter pipeline tests
bun test src/system-tools/        # system tool tests
bun test --integration            # end-to-end with real/mock APIs
```
