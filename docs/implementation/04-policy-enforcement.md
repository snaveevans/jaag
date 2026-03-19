# Slice 04: Policy Enforcement

> **Goal:** The runtime enforces user-defined safety rules. Mutations require approval, file writes are path-restricted, dangerous commands need human confirmation. The agent cannot bypass or see these rules.

**Prerequisites:** Slice 01 (Skeleton), Slice 02 (Memory & Files), Slice 03 (Tool Spec Interpreter — needed for trust tier enforcement and `model_approval_sufficient`)

**Architecture references:** docs/architecture.md — Policy Layer, Policy Enforcement, Spec Trust Model

---

## What This Slice Delivers

1. Policy file loading and parsing (`~/.agent-policy/policy.yaml`)
2. The enforcement gate — a single function every policy-gated primitive call passes through
3. Runtime-triggered approval flow (policy asks user for approval via the communication adapter)
4. Approval receipt tracking (double approval prevention)
5. Rate limiting with persistent counters
6. Default policy that ships out of the box

---

## Tasks

### Task 4.1: Policy File Loading
- Create policy module:
  ```
  src/
    policy/
      loader.ts          # parse policy.yaml, validate rules
      types.ts           # PolicyRule, PolicyAction, MatchCriteria types
      engine.ts          # the enforcement gate
      rate-limiter.ts    # sliding window rate limit tracking
      receipts.ts        # approval receipt tracking
  ```
- Parse policy.yaml into an ordered list of rules
- Validate rule structure: required fields (primitive, action), valid action values, valid match fields per primitive type
- If policy file is missing → use hardcoded default policy
- If policy file is malformed → fail startup with clear error (do not start with no policy)

### Task 4.2: The Enforcement Gate
- Single function that every non-exempt primitive call passes through:
  ```typescript
  async function enforcePolicy(
    primitive: string,
    params: Record<string, any>,
    context: SessionContext
  ): Promise<PolicyDecision>
  
  type PolicyDecision = 
    | { action: 'allow' }
    | { action: 'block', reason: string }
    | { action: 'approve', approved: boolean, reason?: string }
    | { action: 'rate_limited', retryAfter: number }
  ```
- Exempt primitives: `interact`, `memory` → skip gate entirely
- Extract match parameters from the primitive call:
  - `http`: domain (from URL), path, method, tool ID, trust tier
  - `file_read`: path
  - `file_write`: path
  - `execute`: command string
  - `schedule`: trigger type
- Walk rules in order (first match wins)
- No rule matches → default allow
- Log every enforcement decision (primitive, params, matched rule, decision)

### Task 4.3: Runtime-Triggered Approval Flow
- When policy decision is `approve`:
  1. Check for valid approval receipt (see Task 4.4)
  2. If receipt found and rule has `model_approval_sufficient: true` → allow
  3. Otherwise, construct approval message from the primitive call context:
     - `http POST api.github.com/repos/x/issues` → "Agent wants to create a GitHub issue in repo X. Allow?"
     - `execute rm -rf /tmp/build` → "Agent wants to run shell command: rm -rf /tmp/build. Allow?"
     - `file_write /some/path` → "Agent wants to write to /some/path. Allow?"
  4. Send directly via communication adapter (bypass interact queue)
  5. Await user response (yes/no)
  6. Return decision to the enforcement gate
- User approval timeout: 5 minutes (longer than interact timeout — the user is being asked a direct question by the runtime, not by the agent)

### Task 4.4: Approval Receipt Tracking
- When the model calls `interact(mode: approve)` and the user says yes, record an approval receipt in the session:
  ```typescript
  interface ApprovalReceipt {
    timestamp: Date
    tool?: string
    operation?: string
    summary: string
  }
  ```
- Receipt validity: same session AND within 5 minutes AND same tool + operation
- Receipt lookup: when policy gate fires with `model_approval_sufficient: true`, search session receipts for a match
- Receipts are in-memory only (session-scoped, not persisted)

### Task 4.5: Rate Limiting
- Implement sliding window counter per rate limit rule:
  ```sql
  CREATE TABLE IF NOT EXISTS rate_limits (
    rule_id TEXT NOT NULL,
    timestamp TEXT NOT NULL,  -- ISO 8601 of each counted event
    PRIMARY KEY (rule_id, timestamp)
  );
  ```
- On each call matching a rate limit rule: count events within the window → if under limit, allow and record → if over, block and return time until window resets
- Rate limits evaluated BEFORE allow/block/approve rules
- Clean up expired entries periodically (on each check, delete entries outside the window)

### Task 4.6: Default Policy
- Create a default policy file installed on first startup if none exists:
  ```yaml
  # Default Agent Policy — secure defaults
  rules:
    - primitive: execute
      match: { command: ["git status", "git diff *", "git log *", "ls *", "cat *", "head *", "tail *", "wc *", "find *", "which *"] }
      action: allow

    - primitive: execute
      action: approve

    - primitive: http
      match: { method: [GET, HEAD, OPTIONS] }
      action: allow

    - primitive: http
      match: { trust_tier: untrusted }
      action: approve
      model_approval_sufficient: false

    - primitive: http
      match: { method: [POST, PUT, PATCH, DELETE] }
      action: approve
      model_approval_sufficient: true

    - primitive: http
      action: allow

    - primitive: file_write
      match: { path: "~/.agent/workspace/**" }
      action: allow

    - primitive: file_write
      action: block

    - primitive: file_read
      action: allow

    - primitive: schedule
      action: allow
  ```

### Task 4.7: Policy Summary for System Prompt
- Generate a human-readable summary of the policy for inclusion in the system prompt:
  - "You can read files anywhere. You can write files in your workspace directory. Shell commands require user approval except for read-only git/ls/cat commands. HTTP GET requests are allowed. HTTP mutations require approval."
- This gives the model enough awareness to avoid futile attempts without revealing the actual rules

---

## Definition of Done

1. Policy file is loaded at startup, malformed file prevents startup
2. `file_write` outside workspace is blocked — agent gets clear error
3. `execute` commands not on allowlist trigger approval prompt to user
4. HTTP mutations (POST/PUT/DELETE) trigger approval when policy says so
5. User can approve or deny — agent gets result and adjusts behavior
6. Double approval is prevented: model asks "send email?", user says yes, policy gate doesn't ask again
7. Rate limiting works: configure 5 actions per minute → 6th action is blocked with retry time
8. Default policy is installed on first run
9. Policy changes take effect on daemon restart

## Testing Approach

### Unit Tests
- **Policy loader:** Valid policy parses correctly. Malformed policy throws. Missing file returns defaults.
- **Enforcement gate:** Test each action type (allow, block, approve). Test first-match ordering (specific rule before catch-all). Test exempt primitives bypass gate.
- **Pattern matching:** Test glob matching for paths, domains, commands. Test method list matching. Test trust tier matching.
- **Approval receipts:** Test receipt creation, validity window (5 min), tool+operation matching, expiry.
- **Rate limiter:** Test counting, window sliding, blocking when over limit, retry-after calculation.

### Integration Tests
- Start daemon with test policy → attempt blocked file_write → verify rejection
- Attempt execute command → verify approval prompt appears on WebSocket client → approve → verify command runs
- Model calls interact(approve) → user says yes → model calls matching HTTP mutation → verify policy gate is satisfied without second prompt
- Configure rate limit → fire rapid calls → verify blocking after limit

### Test Commands
```bash
bun test src/policy/              # all policy unit tests
bun test --integration            # integration tests with real daemon
```
