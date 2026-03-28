# Primitive Agent Architecture

> **Thesis:** Most "agent frameworks" operate at the wrong abstraction layer. Instead of coding orchestration logic, define a minimal set of universal primitives and let the model handle routing. Tools become declarative JSON specs — not code.

Related ADRs:
- `docs/decisions/ADR-0001-use-seven-runtime-primitives-for-agent-capabilities.md`
- `docs/decisions/ADR-0003-enforce-safety-outside-agent-controlled-specs.md`
- `docs/decisions/ADR-0004-use-sqlite-fts5-memory-with-keyed-and-fuzzy-access.md`
- `docs/decisions/ADR-0005-run-scheduled-work-as-full-agent-sessions.md`

---

## The Core Idea

To make an AI agent useful, you need three things:
1. **Instructions** — what the agent should do (declarative, natural language)
2. **Tools** — how the agent interacts with the world (APIs, files, systems)
3. **Data** — what the agent knows (context, memory, user knowledge)

Current frameworks (LangChain, Semantic Kernel, CrewAI, etc.) encode all three in code — Python classes, typed chains, orchestration graphs. This code breaks every time a model updates because it's tightly coupled to specific APIs and behaviors.

**The alternative:** a small set of hardcoded **primitives** (the only real code), plus **declarative tool specs** (JSON/YAML) that describe higher-level tools in terms of those primitives. The model reads the specs, understands the interfaces, and orchestrates everything itself.

### Why 7 Primitives?

- Small enough to implement, audit, and secure thoroughly
- Large enough to cover the vast majority of real-world agent scenarios
- Each primitive represents a fundamentally different **category of capability** with distinct trust and permission implications
- New higher-level tools are composed from these primitives via declarative specs — not new code
- It is easier to add primitives later than to remove them; starting minimal forces discipline

---

## The 7 Primitives

> **Current status:** This overview describes the target primitive model. In the current runtime, `schedule` is currently shipped for time-based triggers (`once`/`cron`), while event-based scheduling and the `execute` primitive are still planned follow-up work.

### 1. `http` — Network Communication

**What it does:** Makes HTTP requests to any URL. GET, POST, PUT, DELETE, PATCH. Handles headers, query parameters, request bodies, and response parsing.

**Why it exists:** This is the universal connector. Every SaaS API, every web service, every cloud platform speaks HTTP. A single `http` primitive can talk to Gmail, GitHub, Stripe, Slack, Jira, or any REST/GraphQL API — provided the agent has the right spec and credentials.

**Boundary:** Stateless. Each call is independent. No session management, no persistent connections (use `execute` for those edge cases).

**Permission implications:** Network access. Can exfiltrate data or call paid APIs. Requires credential management (API keys, tokens). Consider allowlists for domains.

**Example invocation:**
```json
{
  "primitive": "http",
  "method": "POST",
  "url": "https://api.github.com/repos/{owner}/{repo}/issues/{issue_number}/comments",
  "headers": {
    "Authorization": "Bearer ${GITHUB_TOKEN}",
    "Accept": "application/vnd.github.v3+json"
  },
  "body": {
    "body": "This issue has been picked up. PR incoming."
  }
}
```

---

### 2. `file_read` — Read Files and Directories

**What it does:** Reads file contents, lists directory structures, searches file trees by name/pattern. The "eyes" of the agent for local filesystems.

**Why it exists:** Agents need to understand codebases, read configuration files, inspect project structures, and gather context from local files. This is the most common operation in any development-oriented agent workflow.

**Boundary:** Read-only. Zero side effects. Idempotent. Safe to grant liberally.

**Permission implications:** Information access only. Could expose sensitive files (secrets, configs). Scope to specific directories.

**Example invocation:**
```json
{
  "primitive": "file_read",
  "operation": "read",
  "path": "/workspace/src/components/Header.tsx"
}
```
```json
{
  "primitive": "file_read",
  "operation": "list",
  "path": "/workspace/src/",
  "pattern": "**/*.test.ts"
}
```

---

### 3. `file_write` — Create and Modify Files

**What it does:** Creates new files, modifies existing file content, deletes files. The "hands" of the agent for local mutations.

**Why it's separate from `file_read`:** This is a deliberate security architecture decision. Reading a codebase is safe. Modifying it is destructive. You want to be able to grant an agent `file_read` without `file_write` and know nothing will change. Different trust levels demand different primitives.

**Boundary:** Destructive. Mutations are not automatically reversible (though `execute` + git can provide that). Should support atomic writes (write to temp, then move).

**Permission implications:** Can corrupt or destroy data. Should be scoped to specific directories. Consider requiring `interact` approval for writes outside designated areas.

**Example invocation:**
```json
{
  "primitive": "file_write",
  "operation": "write",
  "path": "/workspace/src/utils/helpers.ts",
  "content": "export function formatDate(date: Date): string {\n  return date.toISOString().split('T')[0];\n}\n"
}
```

---

### 4. `execute` — Run Code and Shell Commands

**What it does:** Executes shell commands, scripts, or code snippets in a sandboxed environment. This is the "escape hatch" — anything that can't be expressed declaratively can be done imperatively through `execute`.

**Why it exists:** Some operations don't map to simple HTTP calls or file I/O: running test suites, compiling code, git operations, complex data transformations, grep/search across codebases, installing dependencies. `execute` handles all of these.

**Boundary:** Sandboxed. Should have resource limits (CPU, memory, time). Should have filesystem and network restrictions configurable per-agent.

**Permission implications:** The most powerful and dangerous primitive. Can do anything the host system can do. Requires the strongest sandboxing and scoping. Consider: read-only filesystem + no network as default, explicitly grant more.

**Subsumes:** `search` (via grep/ripgrep/find), `git` operations, `test` running, `build` commands.

**Example invocation:**
```json
{
  "primitive": "execute",
  "command": "cd /workspace && npm test -- --coverage",
  "timeout_seconds": 120,
  "sandbox": {
    "network": false,
    "writable_paths": ["/workspace"]
  }
}
```

---

### 5. `memory` — Persistent Knowledge Store

**What it does:** Stores, queries, and updates persistent knowledge that survives across sessions and conversations. This is the agent's long-term brain — user preferences, learned patterns, historical context, accumulated knowledge.

**Why it exists:** This is the only **stateful** primitive. Everything else is stateless — `http` calls are independent, files are read fresh each time, `execute` runs in clean sandboxes. But real utility requires the agent to *remember*: your wife likes handmade jewelry, your team uses conventional commits, the last grocery order had too much bread.

**Two access modes:**
- **Keyed** — deterministic exact lookup. `get("preferred_store")` always returns the same thing. Used for tool state, credentials, specific named values. Keys are declared in the tool spec and auto-prefixed with the tool ID by the runtime to guarantee global uniqueness.
- **Fuzzy** — full-text search over memory content. `query("food preferences")` returns ranked results. Used for general knowledge, learned patterns, accumulated context. Ranked by recency and access frequency.

**Boundary:** Personal and private. Memory is user-scoped, stored as a single SQLite file, portable across systems. Supports full-text search via FTS5. No external dependencies.

**Permission implications:** Contains the most sensitive data — personal preferences, habits, relationships, credentials. Encryption at rest. User must be able to inspect, edit, and delete any memory.

**Example invocations:**
```json
{
  "primitive": "memory",
  "operation": "get",
  "key": "preferred_store"
}
```
```json
{
  "primitive": "memory",
  "operation": "store",
  "key": "preferred_store",
  "content": "Whole Foods on Main Street, delivers on Tuesdays"
}
```
```json
{
  "primitive": "memory",
  "operation": "query",
  "text": "What are the family's food preferences and allergies?",
  "limit": 10
}
```
```json
{
  "primitive": "memory",
  "operation": "store",
  "content": "User's wife prefers experiences over material gifts. Last anniversary: cooking class was a hit."
}
```

---

### 6. `schedule` — Time and Event-Based Triggers

**What it does:** Registers time-based triggers (cron-like schedules) and event-based triggers (webhooks, file watchers, state changes) that cause the agent to wake up and act without being prompted.

**Why it exists:** This is the only primitive that **initiates** rather than **responds**. Without `schedule`, agents are purely reactive — they sit idle until a human types something. With `schedule`, agents become proactive: reminding you to drink water, noticing it's Monday and time to plan groceries, alerting you that an anniversary is approaching.

**Boundary:** Triggers initiation of a workflow, but doesn't execute the workflow itself — it hands off to the model, which then uses other primitives. Think of it as the alarm clock, not the morning routine.

**Permission implications:** Can cause the agent to act autonomously at any time. User must be able to see, modify, and cancel all scheduled triggers. Consider requiring `interact` approval for any schedule that involves `file_write` or `http` with side effects.

**Example invocation:**
```json
{
  "primitive": "schedule",
  "operation": "create",
  "trigger": {
    "type": "cron",
    "expression": "0 9 * * 1",
    "description": "Every Monday at 9am"
  },
  "workflow": "grocery_planning",
  "context": {
    "instruction": "Plan meals for the week and propose a grocery list"
  }
}
```
```json
{
  "primitive": "schedule",
  "operation": "create",
  "trigger": {
    "type": "event",
    "source": "github",
    "event": "issues.assigned",
    "filter": { "assignee": "agent-bot" }
  },
  "workflow": "issue_to_pr",
  "context": {
    "instruction": "Read the issue, implement the change, open a PR"
  }
}
```

---

### 7. `interact` — Human Communication

**What it does:** Sends information to the user and optionally waits for a response. Covers the full spectrum: one-way notifications ("your PR is ready"), questions ("should I use React or Vue for this?"), and approval gates ("here's the draft email — send it?").

**Why it exists:** This is the only primitive that involves a **human**. Every other primitive interacts with machines. `interact` is the bridge between autonomous agent execution and human oversight. It's what keeps the agent from going rogue — the ability to pause, show work, and ask permission.

**Boundary:** Can be blocking (wait for response) or non-blocking (fire-and-forget notification). Should support multiple channels (in-app, push notification, SMS, email) configurable per user.

**Permission implications:** Can spam the user. Should have rate limiting and priority levels. Critical: approval-gated actions (sending emails, deploying code, spending money) must use blocking `interact` — the agent must not proceed without explicit human approval.

**Modes:**
- `notify` — One-way. Inform the user. Don't wait. ("PR #42 is ready for review.")
- `ask` — Two-way. Ask a question. Wait for response. ("The issue mentions 'improve performance' — do you want me to focus on load time or memory usage?")
- `approve` — Two-way gate. Show proposed action. Wait for yes/no. ("Here's the draft email. Send it?")

**Example invocation:**
```json
{
  "primitive": "interact",
  "mode": "approve",
  "channel": "push",
  "message": "I've completed the implementation for issue #127. Here's a summary of changes:\n- Added formatDate utility\n- Updated Header component\n- Added 3 test cases (all passing)\n\nReady to open PR?",
  "options": ["Open PR", "Show me the diff first", "Cancel"]
}
```

---

## Primitive Relationship Map

```
                    ┌─────────────┐
                    │   schedule   │  ← The only primitive that INITIATES
                    │  (Layer 0)   │
                    └──────┬──────┘
                           │ triggers
                           ▼
                    ┌─────────────┐
                    │    MODEL     │  ← Reads instructions, specs, memory
                    │  (Reasoning) │     Decides which primitives to call
                    └──┬──┬──┬──┬─┘
                       │  │  │  │
          ┌────────────┘  │  │  └────────────┐
          ▼               ▼  ▼               ▼
    ┌──────────┐   ┌───────┐ ┌────────┐  ┌──────────┐
    │   http   │   │ file  │ │ file   │  │ execute  │  ← Layer 1: World interaction
    │          │   │ read  │ │ write  │  │          │
    └──────────┘   └───────┘ └────────┘  └──────────┘

          ┌──────────────────────────────────┐
          │             memory               │  ← Layer 1.5: State (persistent)
          └──────────────────────────────────┘

          ┌──────────────────────────────────┐
          │            interact              │  ← Layer 2: Human bridge
          └──────────────────────────────────┘
```

---

## The Primitive Test: Why Not 6? Why Not 8?

**Could we merge `file_read` and `file_write` into `file`?**
No. Different trust boundaries. An agent with read-only access is fundamentally safer than one with write access. Security demands the split.

**Could we merge `interact` modes (notify/ask/approve) into separate primitives?**
No need. They're the same capability (human communication) at different interaction levels. One primitive, three modes.

**Could `execute` absorb `file_read` and `file_write`?**
Technically yes — you could `cat` a file or `echo >` into one via shell. But that defeats sandboxing. `file_read` and `file_write` have clear permission scoping that `execute` deliberately does NOT have as defaults. The separation enables fine-grained security policies.

**What about `observe` / `watch` as a separate primitive?**
Tempting. Event-based triggers (watch for new GitHub issue, watch for file change) could be their own thing. But `schedule` already handles event-based triggers alongside time-based ones. Adding `observe` would split a natural category. If event-based triggering proves fundamentally different in practice, this is the most likely 8th primitive.

**What about `auth` as a separate primitive?**
Authentication (OAuth flows, token refresh, credential storage) is complex enough to deserve attention, but it's a *cross-cutting concern* rather than a distinct capability. Auth attaches to `http` calls and `memory` storage. It's middleware, not a primitive.

---

## Declarative Tool Specs

With 7 primitives, higher-level tools become JSON specs rather than code. The agent reads the spec, understands the interface, and executes using primitives.

**Example: GitHub tool spec**
```json
{
  "tool": "github",
  "description": "Interact with GitHub repositories, issues, and pull requests",
  "auth": {
    "type": "bearer_token",
    "env_var": "GITHUB_TOKEN"
  },
  "base_url": "https://api.github.com",
  "default_headers": {
    "Accept": "application/vnd.github.v3+json"
  },
  "operations": {
    "get_issue": {
      "description": "Read a GitHub issue by number",
      "method": "GET",
      "path": "/repos/{owner}/{repo}/issues/{issue_number}",
      "params": {
        "owner": { "type": "string", "required": true },
        "repo": { "type": "string", "required": true },
        "issue_number": { "type": "integer", "required": true }
      },
      "primitive": "http"
    },
    "create_comment": {
      "description": "Add a comment to an issue or PR",
      "method": "POST",
      "path": "/repos/{owner}/{repo}/issues/{issue_number}/comments",
      "params": {
        "owner": { "type": "string", "required": true },
        "repo": { "type": "string", "required": true },
        "issue_number": { "type": "integer", "required": true }
      },
      "body": {
        "body": { "type": "string", "required": true, "description": "The comment text" }
      },
      "primitive": "http"
    },
    "create_pull_request": {
      "description": "Open a pull request",
      "method": "POST",
      "path": "/repos/{owner}/{repo}/pulls",
      "params": {
        "owner": { "type": "string", "required": true },
        "repo": { "type": "string", "required": true }
      },
      "body": {
        "title": { "type": "string", "required": true },
        "body": { "type": "string", "required": true },
        "head": { "type": "string", "required": true, "description": "Branch with changes" },
        "base": { "type": "string", "required": true, "description": "Branch to merge into" }
      },
      "primitive": "http"
    }
  }
}
```

The model reads this spec and knows: "To create a PR, I use the `http` primitive with a POST to this URL with these parameters." No SDK. No framework code. Just data.

---

## Policy Layer

The Policy Layer is a user-controlled safety configuration that exists **outside the agent's context**. The agent cannot read, modify, or circumvent it. It is enforced by the runtime, not by the model.

### Why It Exists

Tool specs contain a `side_effects` field that helps the model make informed decisions about consequences (see the tool spec format doc). But this is a **hint**, not **enforcement**. Two problems make hints insufficient:

1. **Agents can generate their own tool specs.** A model could write a spec that omits or understates side effects - accidentally or deliberately.
2. **Models can ignore hints.** Even with accurate side effects, the model might decide to proceed without asking.

Safety enforcement must live in a layer the agent cannot influence.

### What the Policy Layer Controls

| Policy | Example | Enforcement |
|--------|---------|-------------|
| Domain allowlist/blocklist | Only allow `http` to `api.github.com`, `gmail.googleapis.com` | Runtime blocks requests to all other domains |
| Path restrictions | `file_write` only permitted in `/workspace/` | Runtime rejects writes outside allowed paths |
| Approval gates | Any `http` POST/PUT/PATCH/DELETE requires approval | Runtime injects `interact(mode: approve)` before executing |
| Financial controls | Block or require approval for operations involving payments | Runtime enforces spending limits |
| Rate caps | Max 10 outbound emails per hour, max 50 API calls per minute | Runtime enforces regardless of what the spec allows |
| Spec trust enforcement | Untrusted specs: all mutating operations require approval | Runtime applies automatic gates based on spec origin |
| Primitive restrictions | Agent cannot use `execute` or `schedule` | Runtime blocks calls to disallowed primitives entirely |

### Policy Is Not In the Spec

This is a critical architectural decision. The policy configuration is separate from tool specs. The user controls it. The agent never sees it.

The runtime reads both the tool spec (what the agent wants to do) and the policy (what the agent is allowed to do), and enforces the policy as middleware:

```
Agent calls http(POST to api.github.com/issues/42/comments)
  → Runtime checks Policy Layer
    → Domain allowed? ✓ (api.github.com is in allowlist)
    → Method allowed? ✓ (POST permitted for this domain)
    → Approval required? Check policy... No → Execute

Agent calls http(POST to api.stripe.com/v1/charges)
  → Runtime checks Policy Layer
    → Domain allowed? ✓ (api.stripe.com in allowlist)
    → Financial operation? ✓ (matched by policy rule)
    → Approval required? YES →
      → Runtime triggers interact(mode: approve,
          message: "Agent wants to create a Stripe charge for $47.50. Allow?")
      → User approves → Execute
      → User denies → Block, return denial to agent
```

### Relationship to `side_effects`

These are complementary, not redundant:

- **`side_effects` in the tool spec** = model awareness. Helps the model make good decisions about when to proceed vs. when to ask.
- **Policy Layer** = runtime enforcement. Prevents bad decisions from executing, regardless of what the model decides.

A well-informed model with good `side_effects` data will rarely trigger policy blocks. But when it does, the policy is the last line of defense. Belt and suspenders.

---

## Spec Trust Model

Not all tool specs are equally trustworthy. A spec hand-written by a developer and shipped with the system is fundamentally different from one generated by an AI model mid-conversation. The architecture recognizes three trust levels:

### Trust Levels

| Level | Origin | Review Status | Behavior |
|-------|--------|---------------|----------|
| **Trusted** | Human-authored | N/A | Operations execute per spec rules + Policy Layer |
| **User-reviewed** | Agent-generated | Approved by user | Same as Trusted |
| **Untrusted** | Agent-generated | Not yet reviewed | ALL mutating operations require approval |

### How Trust Is Determined

- Specs in a designated trusted directory (e.g., `~/.agent/tools/trusted/`) are **Trusted**
- Specs generated by the agent during a session start as **Untrusted**
- User can promote Untrusted → User-reviewed via `interact(mode: approve)` where the runtime shows the user the full spec for review
- User-reviewed specs can be saved to the trusted directory to become Trusted on future sessions

### What Changes With Trust Level

For **Untrusted** specs, the runtime wraps every mutating operation (POST, PUT, PATCH, DELETE, `file_write`, `execute`) with an automatic approval gate - equivalent to injecting `interact(mode: approve)` before execution. The agent doesn't know this is happening; the runtime enforces it transparently.

For **Trusted** and **User-reviewed** specs, the runtime trusts the spec's `side_effects` hints and defers to the Policy Layer for enforcement. No additional automatic gates.

Important: trust level never bypasses the Policy Layer. A Trusted spec calling a blocked domain still gets blocked. Trust only removes the *automatic* mutation gates that Untrusted specs have.

### Why Agents Generate Specs

This isn't hypothetical. Consider: *"Hey agent, I need you to interact with my company's internal API at api.internal.com. Here are the docs."*

The agent could:
1. Read the API documentation (via `http` or `file_read`)
2. Generate a tool spec based on the documentation
3. Start using it immediately

This is zero-config tool integration - incredibly powerful. But it means the agent is writing its own interface descriptions and capability declarations. The trust model ensures that power doesn't come at the cost of safety: the generated spec starts Untrusted, every mutation requires approval, and the user can promote it after review.

---

## Memory System Design

Memory is the only stateful primitive and the backbone of personalization. This section describes its implementation architecture.

### Principles

1. **One file.** Memory is a single SQLite database file. No server, no external dependencies. Copy the file, copy the memory. Portable by default.
2. **Two access modes.** Keyed (exact lookup) and fuzzy (full-text search). Same table, same file, different query paths.
3. **No embeddings (v0.1).** Full-text search via SQLite FTS5 is sufficient at the scale of personal agent memory (hundreds to low thousands of entries). Vector embeddings can be added later as a progressive enhancement without changing the schema.
4. **Automatic scoping.** The runtime derives memory keys from the tool ID, preventing collisions without requiring coordination between tool authors.
5. **Recency and frequency.** Fuzzy queries rank results by how recently and how often a memory has been accessed — matching how human memory naturally works.

### Schema

```sql
CREATE TABLE memories (
  id INTEGER PRIMARY KEY,        -- Auto-incrementing rowid
  key TEXT UNIQUE,               -- Optional. Derived key for exact lookup (e.g., 'gmail:preferred_label')
  domain TEXT,                   -- Derived from tool ID (e.g., 'gmail', 'grocery'). Null for system/cross-tool memories.
  content TEXT NOT NULL,          -- The actual memory content. This is what FTS5 indexes.
  metadata TEXT,                 -- JSON object for arbitrary structured data (e.g., {"expires_at": "2026-04-01T00:00:00Z"})
  created_at TEXT NOT NULL,      -- ISO 8601 timestamp
  updated_at TEXT NOT NULL,      -- ISO 8601 timestamp
  last_accessed_at TEXT NOT NULL, -- Updated every time this memory is returned from a query
  access_count INTEGER DEFAULT 0  -- Incremented every time this memory is returned from a query
);

-- Full-text search index on content (external content FTS5 table synced with memories)
CREATE VIRTUAL TABLE memories_fts USING fts5(content, content=memories, content_rowid=id);

-- Index for key lookups
CREATE UNIQUE INDEX idx_memories_key ON memories(key) WHERE key IS NOT NULL;

-- Index for domain filtering
CREATE INDEX idx_memories_domain ON memories(domain) WHERE domain IS NOT NULL;
```

### Key Derivation

Tools never manage their own key prefixes. The runtime handles it automatically:

1. Tool spec declares `"tool": "grocery"` and `"memory_keys": { "preferred_store": "..." }`
2. Agent calls `memory.store(key: "preferred_store", content: "Whole Foods")`
3. Runtime stores it with derived key `grocery:preferred_store`
4. Agent calls `memory.get(key: "preferred_store")`
5. Runtime looks up `grocery:preferred_store`, returns the content

The tool never sees the prefix. The runtime scopes it transparently.

**Auth namespace:** The auth middleware follows the same pattern with an extra namespace segment:
- Spec declares `"token_storage_key": "tokens"` for tool `"gmail"`
- Runtime stores as `oauth:gmail:tokens`
- Auth middleware retrieves via `oauth:gmail:tokens`
- Pattern: `oauth:{tool_id}:{token_storage_key}`

This guarantees global uniqueness by construction. Two tools declaring a key called `"tokens"` will never collide.

### Operations

| Operation | Input | Behavior |
|-----------|-------|----------|
| `store(key, content, metadata?)` | Keyed | **Upsert.** If the key exists, update content and metadata. If not, create. Runtime auto-prefixes the key with tool ID. |
| `store(content, metadata?)` | Unkeyed | **Insert.** Creates a new fuzzy memory with auto-generated UUID. Domain is set from the calling tool's ID. |
| `get(key)` | Exact | Returns the one memory matching the derived key, or null. Runtime auto-prefixes with tool ID. |
| `query(text, domain?, limit?)` | Fuzzy | FTS5 full-text search on content. Optionally filtered by domain. Results ranked by relevance, recency (`last_accessed_at`), and frequency (`access_count`). |
| `update(id, content?, metadata?)` | By ID | Updates an existing memory by its UUID. |
| `delete(key)` or `delete(id)` | Either | Removes a specific memory by derived key or UUID. |
| `list(domain?, limit?, offset?)` | Browse | Returns memories filtered by domain. For user inspection and management. |

### Keyed vs. Fuzzy: When to Use Which

| Use Case | Access Mode | Example |
|----------|-------------|---------|
| OAuth tokens | Keyed | `get("tokens")` → runtime looks up `oauth:gmail:tokens` |
| Tool configuration | Keyed | `get("preferred_store")` → runtime looks up `grocery:preferred_store` |
| User preferences | Fuzzy | `query("food preferences")` → FTS5 returns relevant memories |
| Learned patterns | Fuzzy | `query("coding conventions for this repo")` → returns accumulated knowledge |
| Historical context | Fuzzy | `query("past grocery orders")` → returns order-related memories ranked by recency |

### Ranking: Recency + Frequency

Fuzzy queries return results ranked by a weighted blend of three signals:

1. **FTS5 relevance** — how well the content matches the search text
2. **Recency** — how recently the memory was last accessed (`last_accessed_at`)
3. **Frequency** — how often the memory has been accessed (`access_count`)

Every time a memory is returned from a `query()` call, the runtime updates `last_accessed_at` and increments `access_count`. This creates a natural reinforcement cycle: useful memories get accessed more, which makes them rank higher, which makes them more accessible. Outdated or contradicted memories naturally sink without explicit deletion.

This mirrors how human memory works. You don't delete your old phone number — you just stop using it, and it fades.

### Expiration

Some memories are time-sensitive (e.g., OAuth tokens, temporary session state). Expiration is stored in the `metadata` JSON field:

```json
{
  "metadata": {
    "expires_at": "2026-04-01T12:00:00Z"
  }
}
```

The runtime checks `metadata->>'expires_at'` on reads and filters out expired entries. Expired memories are invisible to the agent but remain in the database until a periodic cleanup runs. This keeps the read path simple while avoiding silent data loss.

### No Tags (v0.1)

Tags were considered and deliberately deferred. The two viable approaches — tool-defined tags (rigid, bloats context) and model-generated tags (inconsistent) — both have significant downsides. Instead, v0.1 relies on:

- **FTS5 full-text search** on the content itself (the content IS the searchable surface)
- **Domain** derived from tool ID (automatic categorization)
- **Recency + frequency** ranking (relevant memories float to the top)

If full-text search proves insufficient for recall quality, tags or vector embeddings can be added in v0.2 without changing the core schema.

### User Inspection

The user must be able to see, edit, and delete any memory the agent has stored. The `list` and `delete` operations support this. The derived key prefix makes it easy to answer questions like:

- "What does the grocery tool know about me?" → `list(domain: "grocery")`
- "Delete everything the agent knows about my family." → `list` + selective `delete`
- "What OAuth tokens are stored?" → `list` filtered by keys matching `oauth:*`

Transparency is non-negotiable. The agent's memory is the user's data.

---

## Schedule System Design

`schedule` is the only primitive that initiates work. Stress testing made it clear that the concept was right but the runtime contract was under-specified: Findings 5.3, 5.5, 5.6, 6.5, and 6.7 all pointed to the same gap, and Cross-Scenario Finding CS.1 called it out directly. This section closes that gap.

### Principles

1. **A trigger creates a normal agent session.** Scheduled execution is not a special mini-runtime with reduced powers.
2. **The instruction is the context.** The runtime injects the stored instruction and metadata, but it does not guess which memories are relevant.
3. **Schedules are durable records.** Every schedule is inspectable, queryable, updatable, and deletable. Hidden timers are not acceptable.
4. **One file.** Schedules live in the same SQLite database as memory, preserving the portability story.
5. **v0.1 stays operationally simple.** UTC storage, a runtime-level timezone, no automatic retries, and no per-schedule timezone.

### Execution Model

This resolves the ambiguity in Finding 5.3 and is confirmed by Findings 5.6, 6.2, and 6.7.

When a schedule trigger fires:

1. The runtime creates a **new agent session**. It is not a continuation of an existing conversation.
2. The session receives `context.instruction`, the current date/time, and schedule metadata: `schedule_id`, `workflow`, and `group`.
3. The session has **full access to all 7 primitives**, constrained by the Policy Layer exactly like any user-initiated session.
4. The session runs to completion and ends.
5. The runtime does **not** auto-inject memory. If the model needs relevant history or preferences, it queries `memory` explicitly. The instruction is the starting context.
6. The `workflow` field is a **human-readable metadata label** used for display and filtering. It is not an executable workflow definition.
7. The only architectural difference between a triggered session and a user-initiated session is the trigger source.

Example runtime payload delivered to the new session:

```json
{
  "trigger_source": "schedule",
  "current_time": "2026-06-01T13:00:00Z",
  "schedule": {
    "schedule_id": "7f0d7c0e-2d0d-4df6-a1c8-06b166ab4f2d",
    "workflow": "daily water reminders",
    "group": "hydration_work_hours"
  },
  "context": {
    "instruction": "Check whether the user is in a meeting. If not, remind them to drink water."
  }
}
```

This is the cleanest execution model because it reuses the existing agent contract instead of inventing a separate "scheduled workflow" subsystem. It also avoids the false precision of auto-loading "relevant" memory. Finding 6.2 validated that the stored instruction is often only a starting prompt; the model still needs live memory access at execution time.

### Trigger Types

Findings 5.4 and 6.6 established that recurring cron alone is not enough.

| Type | Config | Example | Semantics |
|------|--------|---------|-----------|
| `cron` | Standard cron expression | `"0 */2 9-17 * * 1-5"` | Recurring time-based trigger. Best for routines like work-hour hydration reminders. |
| `once` | ISO 8601 datetime | `"2026-03-18T11:30:00Z"` | One-shot trigger. Best for snooze, delayed follow-up, and "remind me in 1 hour." After firing, status becomes `completed`. |
| `event` | External event config | `{ "source": "github", "event": "issues.assigned" }` | External event or webhook trigger. Documented in v0.1, but full implementation is deferred to v0.2 because not every runtime can host durable event infrastructure. |

The important distinction is that trigger type defines **when** a session begins, not **what** the session can do once it starts. After firing, all three converge on the same execution model above.

### Operations

Findings 5.5, 6.4, and 6.5 showed that `create` alone is not a usable schedule primitive. Schedules must be first-class objects with full CRUD.

| Operation | Input | Returns | Notes |
|-----------|-------|---------|-------|
| `create` | trigger config, context, workflow, group (optional) | `schedule_id` (UUID) | Runtime generates the ID. |
| `get` | `schedule_id` | Full schedule object | Single schedule lookup. |
| `list` | Filters: workflow, group, status, trigger_type | Array of schedule objects | Supports filtering and querying. |
| `delete` | `schedule_id` OR `group` | Confirmation + count deleted | Batch delete by group is essential for multi-schedule events. |
| `update` | `schedule_id` + fields to modify | Updated schedule object | Can modify trigger, context, workflow, and group. |

Representative schedule object:

```json
{
  "schedule_id": "0b2c8f15-a8de-45e4-9c82-1d2a64f74f0f",
  "workflow": "anniversary_planning",
  "group": "anniversary_2026",
  "trigger": {
    "type": "once",
    "at": "2026-06-01T13:00:00Z",
    "description": "Two weeks before anniversary"
  },
  "context": {
    "instruction": "Plan for the June 15 anniversary. Query memory for gift preferences and propose options."
  },
  "status": "active",
  "created_at": "2026-03-18T10:00:00Z",
  "last_fired_at": null,
  "next_fire_at": "2026-06-01T13:00:00Z",
  "fire_count": 0,
  "last_fire_status": null
}
```

Example invocations:

```json
{
  "primitive": "schedule",
  "operation": "create",
  "trigger": {
    "type": "cron",
    "expression": "0 */2 9-17 * * 1-5",
    "description": "Every 2 hours during work hours on weekdays"
  },
  "workflow": "daily water reminders",
  "group": "hydration_work_hours",
  "context": {
    "instruction": "Check whether the user is in a meeting. If not, remind them to drink water."
  }
}
```

```json
{
  "primitive": "schedule",
  "operation": "get",
  "schedule_id": "0b2c8f15-a8de-45e4-9c82-1d2a64f74f0f"
}
```

```json
{
  "primitive": "schedule",
  "operation": "list",
  "filters": {
    "workflow": "anniversary_planning",
    "group": "anniversary_2026",
    "status": "active",
    "trigger_type": "once"
  }
}
```

```json
{
  "primitive": "schedule",
  "operation": "delete",
  "group": "anniversary_2026"
}
```

```json
{
  "primitive": "schedule",
  "operation": "update",
  "schedule_id": "0b2c8f15-a8de-45e4-9c82-1d2a64f74f0f",
  "trigger": {
    "type": "once",
    "at": "2026-06-02T13:00:00Z",
    "description": "Rescheduled anniversary planning session"
  },
  "context": {
    "instruction": "Plan for the June 15 anniversary. Query memory for current preferences before proposing options."
  },
  "workflow": "anniversary_planning",
  "group": "anniversary_2026"
}
```

### Identity: `schedule_id`, `workflow`, and `group`

These three fields exist because they solve three different problems. Combining them into one field creates ambiguity immediately.

- **`schedule_id`** is the runtime-generated UUID used for exact identity. It is how `get`, `update`, and single-item `delete` work.
- **`workflow`** is a human-readable purpose label. It is not unique. It exists so the user and the agent can list or filter schedules by intent.
- **`group`** is an optional batch-management label. It ties related schedules together when they are part of one higher-level event.

Concrete example:

| schedule_id | workflow | group | trigger | Purpose |
|-------------|----------|-------|---------|---------|
| `0b2c8f15-a8de-45e4-9c82-1d2a64f74f0f` | `anniversary_planning` | `anniversary_2026` | `once` on June 1 | Start planning two weeks early |
| `5e71d5b1-0d63-4a58-8c87-7bdf1ac0e7dd` | `anniversary_planning` | `anniversary_2026` | `once` on June 14 | Day-before reminder |
| `93e1d7e7-1ca4-457a-8f27-2b8d7d1a65ce` | `anniversary_planning` | `anniversary_2026` | `once` on June 18 | Follow up on booking or gift outcome |

The anniversary scenario from Scenario 6 is exactly why all three matter. The three schedules share one purpose (`workflow`) and one batch identity (`group`), but they still need unique IDs for precise inspection and edits. If the user says "cancel all anniversary reminders," `delete(group: "anniversary_2026")` handles it cleanly. If the user says "move the day-before reminder to noon," the agent updates exactly one `schedule_id`.

### Storage

Schedules live in the same SQLite file as memory. This preserves the same core portability principle: one file, fully portable. Copy the database and you copy both the agent's long-term knowledge and its future commitments.

```sql
CREATE TABLE schedules (
  id TEXT PRIMARY KEY,           -- UUID
  workflow TEXT,                  -- human-readable label
  group_label TEXT,              -- optional grouping for batch ops
  trigger_type TEXT NOT NULL,    -- 'cron', 'once', 'event'
  trigger_config TEXT NOT NULL,  -- JSON: cron expression, datetime, or event config
  context TEXT NOT NULL,         -- JSON: { instruction, metadata }
  status TEXT NOT NULL DEFAULT 'active',  -- active, paused, completed, failed
  created_at TEXT NOT NULL,      -- ISO 8601
  last_fired_at TEXT,            -- ISO 8601, null if never fired
  next_fire_at TEXT,             -- ISO 8601, precomputed for cron/once
  fire_count INTEGER DEFAULT 0,
  last_fire_status TEXT          -- 'success', 'failed', null
);

CREATE INDEX idx_schedules_status ON schedules(status);
CREATE INDEX idx_schedules_workflow ON schedules(workflow);
CREATE INDEX idx_schedules_group ON schedules(group_label);
CREATE INDEX idx_schedules_next_fire ON schedules(next_fire_at);
```

The external primitive API uses `group`, but the table uses `group_label` because `group` is a SQL reserved word. `trigger_config` and `context` stay as JSON because the shape varies by trigger type and future extensions. `next_fire_at` is precomputed so the scheduler loop can do a simple indexed query instead of re-parsing every cron expression on every tick.

### Lifecycle Rules

The runtime tracks two related but distinct things:

- **`status`** = scheduler state (`active`, `paused`, `completed`, `failed`)
- **`last_fire_status`** = outcome of the most recent execution attempt (`success`, `failed`, `null`)

That distinction matters. A cron schedule can stay `active` even if its last run failed.

| Case | Runtime behavior | Rationale |
|------|------------------|-----------|
| `once` fires | Create session, set `last_fired_at`, increment `fire_count`, then set `status = 'completed'` | One-shot schedules should remain in the database for history and audit, not disappear silently. |
| `cron` fires | Create session, recompute `next_fire_at`, set `last_fired_at`, increment `fire_count`, keep `status = 'active'` | Recurring schedules are durable until explicitly deleted or paused. |
| Execution fails | Set `last_fire_status = 'failed'`; do **not** auto-retry | Automatic retry policies add complexity, and most agent failures need different context rather than the same prompt again. |
| Trigger was missed while runtime was down | Fire **once** on catch-up, then recompute `next_fire_at` from current time | This avoids absurd replay behavior. Missing 5 water reminders should not produce 5 back-to-back reminders on reboot. |

This catch-up rule came directly out of the water reminder stress test. One catch-up plus normal cadence is the user-friendly behavior; replaying every missed cron tick is technically faithful and operationally terrible.

### Policy Layer Interaction

Scheduled autonomy is safe only if the Policy Layer applies at two points, not one.

| Stage | Enforcement |
|-------|-------------|
| Creation time | The Policy Layer can reject the schedule before it is stored. Example: "no schedules that fire more than once per hour." |
| Execution time | Every primitive call made by the triggered session goes through the Policy Layer exactly like a user-initiated session. |

This design matters because schedule creation and schedule execution are different risks. Creation controls **whether** an autonomous action can exist at all. Execution controls **what** the resulting session is allowed to do when it wakes up.

The system also supports trigger-source-aware policies as an extension. A rule can say: "If `trigger_source = schedule`, block this class of action even though it would be allowed in a user-initiated session." For example, scheduled sessions might be blocked from initiating a financial approval flow via `interact(mode: approve)`, requiring the user to start that flow manually. This keeps the primitive set consistent while still letting the runtime be stricter with autonomous triggers.

### Edge Cases

- **Concurrent triggers.** If two schedules fire at the same time, the runtime creates two independent sessions. There is no shared in-memory session state. If both write to `memory`, SQLite serialization handles write locking at commit time.
- **Trigger fires during an active user session.** The triggered session runs in parallel. It does not wait for the user's current conversation to finish, and it does not merge itself into that conversation.
- **Timezones.** All timestamps are stored internally as UTC. Cron expressions are evaluated using one runtime-level timezone setting. If the runtime timezone is `America/New_York`, then `"0 9 * * *"` means 9am Eastern, which the runtime converts into UTC for storage and comparison. There is no per-schedule timezone in v0.1.

This runtime-level timezone is a deliberate simplification. It handles the common personal-agent case cleanly and addresses Finding 6.7 without forcing per-schedule timezone management into the first version.

### The `interact` Blocking Problem

This is the trickiest part of the schedule design because it sits at the boundary between autonomous execution and human latency.

**Problem:** A triggered session sends `interact(mode: ask, message: "Did you drink water?")`. The user might not respond for hours. The session cannot block forever.

**Chosen approach: async handoff.**

1. The triggered session sends the `interact` message.
2. The runtime delivers that message to the user (push notification, queued inbox message, or equivalent).
3. The triggered session ends. It does **not** remain alive waiting for a response.
4. When the user eventually responds, the runtime creates a **new session**.
5. That new session receives:
   - the original schedule context (`instruction`, metadata)
   - the prior messages from the triggered session
   - the user's response
6. The new session continues from there.

```text
schedule fires
  -> triggered session runs
  -> interact(mode: ask)
  -> message delivered to user
  -> triggered session ends

user responds later
  -> runtime creates new session
  -> inject original schedule context + prior messages + user response
  -> model continues
```

Why not block? Because blocked sessions holding resources for hours or days do not scale, and they create ugly edge cases immediately: what if another schedule fires while one is suspended, or the user never answers?

Why not make `interact` fire-and-forget? Because the user's eventual reply needs context. Without prior messages and original schedule context, the response becomes an orphaned string.

Async handoff is the middle ground. The prompt gets delivered, the original session ends cleanly, and the eventual response resumes in a fresh session with enough context to continue coherently.

---

## Scenario 4: GitHub Issue to Pull Request

### Overview

**Trigger:** A GitHub issue is assigned to the agent (via `schedule` event trigger), or a user tells the agent to work on a specific issue.

**Goal:** Read the issue, understand the requirements, implement the change, write tests, verify they pass, and open a PR — all autonomously, with human checkpoints.

**Primitives used:** `http`, `file_read`, `file_write`, `execute`, `memory`, `interact`

(6 of 7 primitives — `schedule` would be used if this were triggered automatically rather than manually.)

---

### Step-by-Step Execution Trace

#### Phase 1: Understand the Task

```
Step 1.1 — Read the GitHub issue
├── Primitive: http
├── Action: GET /repos/{owner}/{repo}/issues/{issue_number}
├── Input: owner, repo, issue number (from trigger or user)
├── Output: issue title, body, labels, comments, linked PRs
└── Failure mode: 404 (issue doesn't exist), 401 (bad token)

Step 1.2 — Read issue comments for additional context
├── Primitive: http
├── Action: GET /repos/{owner}/{repo}/issues/{issue_number}/comments
├── Output: all discussion, clarifications, design decisions
└── Failure mode: pagination needed for long threads

Step 1.3 — Check memory for project context
├── Primitive: memory
├── Action: query "What do I know about {repo}? Coding conventions, architecture, past issues?"
├── Output: previously learned patterns, team preferences, tech stack
└── Failure mode: no memory yet (first time working on this repo — proceed with discovery)

Step 1.4 — Model decision point: Do I understand the requirements?
├── Engine: model reasoning (no primitive)
├── If YES → proceed to Phase 2
├── If NO → interact with user
│   ├── Primitive: interact (mode: ask)
│   ├── Message: "Issue #127 says 'improve the date formatting' but doesn't specify:
│   │   - Which date format to use (ISO 8601? locale-aware?)
│   │   - Which components are affected
│   │   Can you clarify, or should I comment on the issue asking?"
│   └── Wait for response, then proceed
└── If PARTIALLY → comment on issue asking for specifics
    ├── Primitive: http
    ├── Action: POST comment on issue asking clarifying questions
    └── Primitive: schedule → set reminder to check for response
```

#### Phase 2: Understand the Codebase

```
Step 2.1 — Read project structure
├── Primitive: file_read
├── Action: list directory tree of repo root
├── Output: folder structure, key config files (package.json, tsconfig, etc.)
└── Purpose: understand project layout, tech stack, build system

Step 2.2 — Read key configuration files
├── Primitive: file_read
├── Action: read package.json, tsconfig.json, .eslintrc, test config
├── Output: dependencies, scripts, linting rules, test framework
└── Purpose: understand conventions and constraints

Step 2.3 — Search for relevant code
├── Primitive: execute
├── Action: grep/ripgrep for keywords from the issue (e.g., "formatDate", "date", component names)
├── Output: file paths and line numbers where relevant code lives
└── Purpose: locate the exact files that need modification

Step 2.4 — Read the relevant source files
├── Primitive: file_read
├── Action: read each file identified in step 2.3
├── Output: full source code of files to modify
└── Purpose: understand current implementation

Step 2.5 — Read existing tests for those files
├── Primitive: file_read
├── Action: read corresponding test files (*.test.ts, *.spec.ts)
├── Output: existing test patterns, assertion style, mocking approach
└── Purpose: match existing test conventions when writing new tests

Step 2.6 — Store learned project context
├── Primitive: memory
├── Action: store "Repo X uses Jest + React Testing Library, follows conventional commits,
│           src/ has components/, utils/, hooks/ structure"
└── Purpose: won't need to rediscover this next time
```

#### Phase 3: Plan the Implementation

```
Step 3.1 — Model decision point: Plan the changes
├── Engine: model reasoning (no primitive)
├── Input: issue requirements + codebase understanding
├── Output: implementation plan:
│   - Files to create
│   - Files to modify (with specific changes)
│   - Test cases to write
│   - Expected behavior changes
└── This is pure reasoning — no primitives needed

Step 3.2 — Interact for complex changes (optional)
├── Primitive: interact (mode: ask)
├── Condition: only if changes are large or ambiguous
├── Message: "Here's my plan for issue #127:
│   1. Create src/utils/dateFormatter.ts with formatDate() and parseDate()
│   2. Update src/components/Header.tsx to use new formatter
│   3. Add 5 test cases covering edge cases
│   Does this approach look right?"
└── Wait for approval or course correction
```

#### Phase 4: Implement

```
Step 4.1 — Create a working branch
├── Primitive: execute
├── Action: git checkout -b issue-127-date-formatting
├── Failure mode: branch already exists → git checkout existing or rename
└── Recovery: execute "git branch -D" and retry, or use incremented name

Step 4.2 — Write/modify source files
├── Primitive: file_write
├── Action: create new files or modify existing files per the plan
├── For each file:
│   ├── If new file → file_write (create)
│   └── If existing file → file_read (get current) → model plans edit → file_write (update)
└── Failure mode: write to wrong path, syntax errors (caught in Phase 5)

Step 4.3 — Write test files
├── Primitive: file_write
├── Action: create or update test files
├── Key: match existing test conventions discovered in Phase 2
└── Include: happy path, edge cases, error cases, regression test for the issue
```

#### Phase 5: Verify

```
Step 5.1 — Run the test suite
├── Primitive: execute
├── Action: npm test (or whatever the project uses)
├── Output: test results — pass/fail, coverage
├── Timeout: 120 seconds (configurable)
└── Failure modes: see below

Step 5.2 — Handle test failures (loop)
├── IF all tests pass → proceed to Phase 6
├── IF new tests fail:
│   ├── Primitive: file_read → read error output
│   ├── Engine: model reasoning → diagnose failure
│   ├── Primitive: file_write → fix the code or test
│   ├── Primitive: execute → re-run tests
│   └── Loop max 3 times, then → interact (ask for help)
├── IF existing tests fail (regression):
│   ├── This is critical — the change broke something
│   ├── Primitive: file_read → read failing test to understand what broke
│   ├── Engine: model reasoning → determine if the test expectation needs
│   │   updating (intentional behavior change) or if the code has a bug
│   ├── Primitive: file_write → fix
│   ├── Primitive: execute → re-run
│   └── If can't resolve after 3 attempts → interact (mode: ask) for guidance
└── IF build/lint errors:
    ├── Primitive: execute → run linter with auto-fix
    ├── Primitive: file_write → apply manual fixes if needed
    └── Primitive: execute → re-run full suite

Step 5.3 — Run linter/formatter
├── Primitive: execute
├── Action: npm run lint, npm run format (or prettier, eslint --fix)
├── Purpose: ensure code meets project style standards
└── Primitive: file_read → verify no unintended changes

Step 5.4 — Verify git status is clean
├── Primitive: execute
├── Action: git diff --stat (review what changed)
├── Engine: model reasoning → sanity check: do the changes match the plan?
└── If unexpected files changed → investigate before proceeding
```

#### Phase 6: Deliver

```
Step 6.1 — Commit changes
├── Primitive: execute
├── Action: git add -A && git commit -m "feat(utils): add date formatting utility

  Implements date formatting as requested in #127.
  - Added formatDate() and parseDate() to src/utils/dateFormatter.ts
  - Updated Header component to use new formatter
  - Added comprehensive test coverage

  Closes #127"
└── Note: commit message follows conventional commits (learned from memory or project config)

Step 6.2 — Push branch
├── Primitive: execute
├── Action: git push origin issue-127-date-formatting
├── Failure mode: push rejected (need to pull/rebase first)
└── Recovery: execute "git pull --rebase origin main" → resolve conflicts → push again

Step 6.3 — Open Pull Request
├── Primitive: http
├── Action: POST /repos/{owner}/{repo}/pulls
├── Body:
│   ├── title: "feat(utils): add date formatting utility"
│   ├── body: structured PR description with:
│   │   - Link to issue (#127)
│   │   - Summary of changes
│   │   - Test coverage notes
│   │   - Screenshots if UI change
│   ├── head: "issue-127-date-formatting"
│   └── base: "main"
└── Output: PR number and URL

Step 6.4 — Notify the user
├── Primitive: interact (mode: notify)
├── Message: "PR #42 is ready for review: https://github.com/{owner}/{repo}/pull/42
│   
│   Changes for issue #127:
│   - Added formatDate() utility
│   - Updated Header component  
│   - 5 new tests, all passing
│   - No regressions in existing tests"
└── Non-blocking — agent's job is done

Step 6.5 — Store outcome in memory
├── Primitive: memory
├── Action: store "Successfully completed issue #127 for {repo}.
│   Approach: created utility function, updated component.
│   PR #42. Tests passed on first run."
└── Purpose: learn from successes and failures over time
```

---

### Decision Tree Summary

```
READ ISSUE
    │
    ├── Don't understand → INTERACT (ask user or comment on issue)
    │
    └── Understand → READ CODEBASE
                        │
                        ├── Complex change → INTERACT (confirm plan)
                        │
                        └── Clear path → IMPLEMENT
                                            │
                                            └── RUN TESTS
                                                  │
                                                  ├── Pass → COMMIT → PUSH → OPEN PR → NOTIFY
                                                  │
                                                  ├── Fail (fixable) → FIX → RE-TEST (loop max 3x)
                                                  │
                                                  └── Fail (stuck) → INTERACT (ask for help)
```

---

### Primitives Used Per Phase

| Phase | http | file_read | file_write | execute | memory | interact |
|-------|:----:|:---------:|:----------:|:-------:|:------:|:--------:|
| 1. Understand | X | | | | X | maybe |
| 2. Explore | | X | | X | X | |
| 3. Plan | | | | | | maybe |
| 4. Implement | | X | X | X | | |
| 5. Verify | | X | X | X | | maybe |
| 6. Deliver | X | | | X | X | X |

Every phase uses a different mix. No primitive is unused. The architecture is minimal and complete.

---

### Failure Modes and Recovery

| Failure | Detection | Recovery | Primitive Used |
|---------|-----------|----------|---------------|
| Issue is vague/ambiguous | Model reasoning after reading issue | Comment on issue asking questions, or ask user | `http` or `interact` |
| Can't find relevant code | Grep returns no results | Broaden search terms, read directory tree | `execute`, `file_read` |
| Tests fail after implementation | Non-zero exit code from test runner | Read error, diagnose, fix, re-run (max 3x) | `execute`, `file_read`, `file_write` |
| Existing tests break (regression) | Test runner reports failures in untouched tests | Analyze if intentional behavior change or bug | `file_read`, `execute` |
| Push rejected | Non-zero exit code from git push | Pull/rebase from main, resolve conflicts | `execute` |
| Stuck after 3 fix attempts | Loop counter | Ask human for help | `interact` |
| Rate limited by GitHub API | 403 response with rate limit headers | Wait and retry, or ask user to proceed manually | `http`, `schedule` |
| Token/auth expired | 401 response | Notify user to refresh credentials | `interact` |

---

## Resolved Design Questions

### Memory Domain Guidelines

*Resolves Findings 1.4 and 5.2.*

Memory entries use the `domain` field to scope storage and retrieval. Two rules govern domain assignment:

1. **Operational state** uses the **tool domain.** Data that is specific to one tool's functioning — timestamps, run history, API-specific status — gets the tool's ID as its domain. Example: "Last Gmail triage was March 18" → `domain: "gmail"`.

2. **User preferences and general knowledge** use **null domain.** Information that describes the person, not a tool — communication style, work hours, dietary preferences, relationship details — gets `domain: null`. This makes it discoverable by any tool. "User prefers shorter emails" stored under `gmail` would be invisible to an Outlook tool. Stored under `null`, any communication tool can find it.

The risk of null-domain accumulation (hundreds of unscoped entries degrading FTS5 recall) is real in theory but not in practice at personal-agent scale. A user would need thousands of general preference entries before FTS5 quality degrades meaningfully. If it does, the migration path is straightforward: introduce a `system` domain or allow model-chosen domain strings. For v0.1, null is correct.

### Double Approval Problem

*Resolves Finding 1.3.*

**The problem:** When the model drafts an email and asks via `interact(mode: approve)` "Send this?", the user says yes. But the Policy Layer may also gate `messages.send` (because `side_effects.reversible: false`), causing the user to approve the same action twice. This is a real friction point that emerges from the interaction between model-initiated approval and Policy Layer gates.

**The direction:** The Policy Layer should support a per-rule flag (e.g., `model_approval_sufficient: true`) indicating that if the model already obtained user approval via `interact(approve)` for the same action, the Policy Layer gate can be satisfied without a second prompt.

**Implementation is deferred.** The exact mechanism — how the runtime tracks that the model obtained approval, what constitutes a "match" between the model's approval request and the policy rule's scope, whether matching is loose or strict — is a runtime implementation concern. Specifying it now would be premature; the right design will emerge when the runtime's approval pipeline is actually being built. The architecture acknowledges the problem and sets the direction, but does not prescribe the plumbing.

---

## Runtime Design

The runtime is the actual executable that brings the architecture to life. It is a single long-running Bun (TypeScript) daemon process that owns the scheduler, manages sessions, serves the communication layer, and dispatches primitive calls. This section defines what the runtime is, how it works, and what it enforces.

The choice of Bun over Node is driven by two specific advantages: built-in SQLite (`bun:sqlite`) eliminates a native dependency for the memory and schedule systems, and fast startup (~10ms vs ~200ms) benefits triggered sessions that spin up and die frequently. Since the bottleneck is always LLM response time, the choice is reversible — the codebase is TypeScript either way.

### Process Model

The daemon is a single Bun process that owns everything.

**What the daemon owns:**

- The SQLite database (memory + schedules)
- The scheduler tick loop
- All active sessions (interactive + triggered)
- The communication server (WebSocket for v0.1)
- Loaded tool specs and policy config

**Directory structure:**

```text
~/.agent/
  config.yaml          # runtime config (LLM API key, timezone, communication settings)
  agent.db             # SQLite (memory + schedules)
  agent.pid            # PID file (prevents double-launch)
  tools/
    trusted/           # human-authored tool specs
    user-reviewed/     # agent-generated, user-approved
    untrusted/         # agent-generated, not yet reviewed
  workspace/           # default working directory for execute primitive
  logs/
    agent.log          # structured JSON logging

~/.agent-policy/       # SEPARATE directory for policy (Layer 1 + Layer 2 protection)
  policy.yaml          # Policy Layer rules
```

The trust-tiered tool spec directories map directly to the Spec Trust Model. The policy directory is separate to support both Layer 1 (runtime path blocklist) and Layer 2 (OS-level file permissions) protection.

**Startup sequence:**

```text
1. Check PID file (~/.agent/agent.pid)
   - If exists and process alive → refuse to start ("daemon already running")
   - If exists and process dead → clean up stale PID file → continue
2. Write PID file
3. Load config from ~/.agent/config.yaml
4. Load policy from ~/.agent-policy/policy.yaml
5. Load and validate tool specs from ~/.agent/tools/ (all three trust tiers)
6. Open SQLite database (~/.agent/agent.db) in WAL mode
7. Start communication server (WebSocket on localhost:port)
8. Start scheduler tick loop
9. Log "daemon ready" → accept connections
```

**Graceful shutdown (`SIGTERM`/`SIGINT`):**

```text
1. Stop the scheduler (no new triggers fire)
2. Stop accepting new connections
3. Wait for active sessions to complete (30-second timeout)
4. If sessions don't finish within timeout → force-terminate, log warning
5. Close SQLite connection
6. Remove PID file
7. Exit cleanly
```

In-flight sessions lost during shutdown are acceptable for v0.1. SQLite is crash-safe with WAL mode. On restart, the scheduler's missed-trigger catch-up rule (fire once, recompute `next_fire_at`) handles any triggers that should have fired during downtime.

**Crash recovery:**

No special recovery logic needed. SQLite with WAL mode survives unclean shutdown. The PID file may be stale (handled on next startup). In-flight sessions are lost (acceptable). The scheduler recomputes on restart.

**Logging:**

Structured JSON logs to `~/.agent/logs/agent.log`. Log levels: `debug`, `info`, `warn`, `error`. Key events logged:

- Daemon start/stop
- Session start/end (with trigger source, session ID)
- Every primitive call (primitive name, key params, success/failure, duration)
- Policy blocks (what was blocked, which rule, why)
- Scheduler trigger fires (schedule ID, workflow)
- Communication connects/disconnects
- Tool spec loads/validation errors

### Core Loop

The daemon runs three concurrent concerns in one process, coordinated by Bun's event loop.

**Scheduler tick loop:**

Runs on a fixed 5-second interval (configurable). Each tick:

```text
1. Query: SELECT * FROM schedules WHERE status = 'active' AND next_fire_at <= now()
2. For each matched schedule:
   a. Create a new triggered session (in-process, async)
   b. Update last_fired_at, increment fire_count
   c. If trigger_type = 'once' → set status = 'completed'
   d. If trigger_type = 'cron' → recompute next_fire_at from current time
3. Done. Next tick in 5 seconds.
```

The 5-second default balances responsiveness against overhead. 1 second is wasteful for a personal agent. 30 seconds means a "remind me in 1 minute" could fire noticeably late. 5 seconds keeps jitter imperceptible to the user while doing minimal work per tick.

**Communication server:**

WebSocket server on localhost (v0.1). When a client connects:

```text
1. Client connects via WebSocket
2. If no active interactive session exists → create one
3. User message arrives → route to active interactive session
4. Session produces response → send back via WebSocket
5. If user disconnects → session stays alive, queues outbound messages
6. If user reconnects → deliver queued messages, resume routing
7. If user sends message while session is mid-LLM-call → queue inbound, deliver when session is ready
```

**Single conversation lane with interact queue:**

The user has one conversation stream. This is a deliberate v0.1 simplification that maps cleanly to every simple communication adapter (Telegram, Slack DM, CLI terminal).

```text
┌─────────────────────────────────┐
│      Communication Adapter      │
│     (one conversation lane)     │
└──────────────┬──────────────────┘
               │
┌──────────────▼──────────────────┐
│        Message Router           │
│                                 │
│  Interactive session active?    │
│    YES → route to it            │
│    NO  → check interact queue   │
│          → deliver next pending │
│          → or wait for user     │
└──────────────┬──────────────────┘
               │
┌──────────────▼──────────────────┐
│        Interact Queue           │
│ FIFO queue of pending messages  │
│ from triggered sessions         │
│ Delivered when lane is free     │
└─────────────────────────────────┘
```

When a triggered session calls `interact` and the user is in an active conversation, the message queues. When the interactive session completes (or times out after 10 minutes of inactivity), the queue drains — next pending message is delivered, user responds, that spawns a mini-session for the triggered context, and the cycle continues.

Timeout for triggered-session `interact` calls (2 minutes) starts from delivery, not from queueing. A message that sits in the queue for 5 minutes and then gets delivered still gets its full 2-minute response window.

Future adapters (Telegram, Slack, mobile app) can implement multi-lane communication with task-style UIs where the user sees and triages pending interactions. The communication adapter interface (Section 5, forthcoming) supports both patterns.

**Session-primitive loop (the ReAct cycle):**

This is the core of what every session does:

```text
1. Build message array (system prompt + context + conversation history)
2. Send to LLM API
3. LLM responds with either:
   a. Text response → deliver to user (interactive) or log (triggered)
      → check if conversation continues or session is done
   b. Primitive call(s) → dispatch each to primitive handler
      → collect results → append to message history → go to step 1
4. Repeat until:
   - LLM produces a final response with no more primitive calls
   - Iteration count hits max (50, configurable)
   - Unrecoverable error occurs
   - Session timeout (10 min inactivity for interactive, 2 min interact timeout for triggered)
```

The 50-iteration safety valve prevents runaway sessions. A session that has made 50 primitive calls without resolving is almost certainly stuck. At that point, the session asks the user for help (interactive) or logs a failure and terminates (triggered).

### Session Model

A session is an in-process async workflow — the central abstraction that everything flows through.

**Session state:**

```typescript
interface Session {
  id: string                          // UUID, generated at creation
  triggerSource: 'user' | 'schedule'  // what initiated this session
  status: SessionStatus               // current state
  messages: Message[]                 // full LLM conversation history
  scheduleContext?: {                 // only present for triggered sessions
    scheduleId: string
    workflow: string
    group?: string
    instruction: string
  }
  toolSpecs: ToolSpec[]               // snapshot from creation time
  iterationCount: number              // safety valve counter
  createdAt: Date
  lastActivityAt: Date                // for inactivity timeout
}

type SessionStatus =
  | 'active'            // executing a primitive or building LLM request
  | 'waiting_for_llm'   // awaiting LLM API response
  | 'waiting_for_user'  // awaiting interact response (with timeout for triggered)
  | 'completed'         // finished successfully
  | 'failed'            // terminated due to error or iteration limit
```

**Concurrency rules:**

- **One interactive session at a time.** If the user is in a conversation and sends a new message, it goes to the existing session. No forking into parallel conversations.
- **Unlimited triggered sessions.** Three schedules fire at once → three independent sessions run concurrently. They share the SQLite database (serialized at write via SQLite's locking) but nothing else.
- The session manager maintains a map: `Map<string, Session>` keyed by session ID, plus a reference to the current interactive session (if any).

**Tool spec snapshots:**

When a session starts, it receives a copy of the currently loaded tool specs. If a spec file is edited while a session is running, the running session does not see the change — the next session will. This prevents mid-session consistency bugs where half an operation uses old auth config and half uses new config.

**LLM message format:**

Each session maintains a `messages` array sent to the LLM on every turn:

```typescript
type Message =
  | { role: 'system', content: string }
  | { role: 'user', content: string }
  | { role: 'assistant', content: string }
  | { role: 'assistant', tool_calls: ToolCall[] }
  | { role: 'tool', tool_call_id: string, content: string }
```

This maps directly to the OpenAI/Anthropic chat format. The LLM sees the full conversation history on every turn, including prior primitive calls and their results.

**System prompt construction:**

For interactive sessions:

```text
1. Base system prompt (agent personality, capabilities, behavioral instructions)
2. Available primitives and their descriptions
3. Available tool specs (name + operations summary)
4. Available system tools (spec.validate, spec.register, etc.)
5. Current date/time
6. Policy summary (what the agent can and cannot do)
```

For triggered sessions, the same as above plus:

```text
7. Schedule context: "You are running because schedule [workflow] fired.
   Schedule ID: [id]. Group: [group]. Your instruction: [instruction]"
```

The difference between session types is minimal — triggered sessions get one extra context block and do not start with a user message.

**Session lifecycle:**

| Session type | Ends when |
|--------------|-----------|
| Interactive | LLM produces final response + 10 minutes of inactivity timeout. Next user message starts a fresh session. |
| Triggered | LLM produces final response with no pending primitive calls. Cleaned up immediately. |
| Either | Iteration count hits max (50). |
| Either | Unrecoverable error (LLM API unreachable, SQLite corruption, etc.). |

The 10-minute inactivity timeout for interactive sessions prevents stale sessions with growing message histories. The user does not notice the boundary — if they return after 3 minutes, they continue the conversation; after 11 minutes, a fresh session starts.

### Primitive Execution

Every primitive call follows the same dispatch pattern:

```text
Session requests primitive call
  → Policy Layer check (block / allow / require user approval)
  → If blocked → return denial reason to session
  → If requires approval → route through interact queue → await user decision
  → Primitive handler executes
  → Result returned to session
  → Result appended to message history as tool role message
  → Next LLM turn
```

The dispatcher routes by primitive name. Every handler shares a uniform signature:

```typescript
type PrimitiveHandler = (
  params: Record<string, any>,
  context: SessionContext
) => Promise<PrimitiveResult>

interface PrimitiveResult {
  success: boolean
  data?: any
  error?: string
}
```

**`http` — the tool spec interpreter**

The most complex handler. It reads a tool spec and translates an operation into an actual HTTP request.

```text
1. Look up tool spec + operation from params (tool name + operation name)
2. Build URL: connection.base_url + operation.path (substitute path parameters)
3. Apply auth middleware:
   a. Check memory for stored token (keyed by oauth:{tool_id}:{token_key})
   b. If token exists and not expired → attach to request
   c. If token expired and refresh available → refresh via token endpoint → store new token → attach
   d. If no token or refresh fails → trigger interact for re-authorization
4. Set headers (from connection defaults + operation overrides)
5. Build query params from operation params
6. Build request body from operation body schema
7. Execute fetch()
8. Parse response according to operation.response mapping
9. Handle errors:
   - 429/503 → retry with backoff (max 3 retries)
   - 401 → trigger auth refresh flow
   - Others → surface error to session
10. Return structured result
```

This is essentially a mini API client generator driven by JSON at request time. It is the most code-dense part of the runtime but not conceptually complex — it is a series of template substitutions and HTTP mechanics.

**`file_read`**

```text
1. Validate path against Policy Layer (allowed directories)
2. Check Layer 1 hardcoded blocklist
3. Read file or list directory via Bun's file API
4. If file exceeds 1MB → truncate and include notice ("truncated at 1MB, file is X bytes total")
5. Return contents
```

The 1MB default limit prevents the model from accidentally loading a massive file into the LLM context. Configurable for specific use cases.

**`file_write`**

```text
1. Validate path against Policy Layer (allowed directories)
2. Check Layer 1 hardcoded blocklist (policy directory, trusted specs directory)
3. Write file via Bun's file API
4. Return confirmation (path, bytes written)
```

The Layer 1 blocklist is hardcoded in the runtime binary. It cannot be modified by the agent, by policy, or by configuration. It is the inner-most defense for critical paths.

**`execute`**

```text
1. Policy Layer check (should almost always require approval for shell commands)
2. Best-effort blocked pattern check (not a security boundary — defense in depth only)
3. Spawn child process via Bun's subprocess API
   - Working directory: ~/.agent/workspace/ (default, configurable)
   - Environment: sanitized (no LLM API key, no secrets leaked to subprocess)
4. Capture stdout + stderr
5. Apply timeout: 30 seconds default (configurable per-call or per-policy)
6. If output exceeds 64KB → truncate with notice
7. Return exit code + stdout + stderr
```

`execute` is the most dangerous primitive and should be the most policy-gated. The default policy should require user approval for all shell commands unless they match an explicit allowlist (e.g. `git status`, `npm test`, `ls`).

The environment sanitization is important: the daemon process holds the LLM API key and other secrets in its own environment. These must not leak into child processes spawned by `execute`. The handler explicitly constructs a clean environment for each subprocess.

**`memory`**

```text
1. Route by operation (get, set, search, list, delete)
2. For 'get': keyed lookup by domain + key → return entry or null
3. For 'set': upsert by domain + key → write to SQLite
4. For 'search': FTS5 query with optional domain filter → return ranked results
5. For 'list': query with filters (domain, key pattern) → return entries
6. For 'delete': remove by domain + key
```

When called in the context of a tool spec operation, the runtime auto-prefixes the domain with the tool ID (e.g. a memory write during a Gmail operation gets `domain: "gmail"` automatically). The model can override this for cross-tool knowledge by explicitly setting `domain: null`.

**`schedule`**

```text
1. Route by operation (create, get, list, delete, update)
2. For 'create': validate trigger config → compute next_fire_at → insert into SQLite → return schedule_id
3. For 'get': lookup by schedule_id → return full schedule object
4. For 'list': query with filters (workflow, group, status, trigger_type) → return array
5. For 'delete': remove by schedule_id OR by group → return count deleted
6. For 'update': modify fields → recompute next_fire_at if trigger changed → return updated object
```

The `create` handler needs a cron expression parser to compute `next_fire_at`. This is a small utility — cron parsing is well-defined and does not require a heavy dependency.

**`interact`**

```text
1. Route by mode (ask, notify, approve)
2. For 'notify': send message via communication adapter → return immediately (no response needed)
3. For 'ask': send message via adapter (or queue if lane busy) → await user response
   - Interactive session: no timeout, user responds naturally
   - Triggered session: 2-minute timeout from delivery
   - On timeout: return timeout indicator, session decides what to do
4. For 'approve': send message via adapter → await yes/no response
   - Same timeout rules as 'ask'
5. Return user's response (or timeout indicator) to session
```

The `interact` handler is the bridge between the session and the communication adapter. It does not know how messages reach the user — it calls the adapter interface and awaits the result.

### System Tools

In addition to the 7 primitives, the runtime exposes a set of **system tools** — built-in operations that are hardcoded in the runtime binary, callable by the model, but immutable at runtime.

System tools exist at a different abstraction level than primitives:

- **Primitives** are universal atomic capabilities. Every agent runtime implements them. Tool specs are expressed in terms of them.
- **System tools** are runtime management operations. They let the agent manage its own toolbox. They are specific to this runtime implementation.

The distinction is analogous to syscalls vs shell built-ins. `read()` and `write()` are syscalls (primitives). `cd` is a shell built-in (system tool). Different layer, different purpose.

**The trust hierarchy:**

```text
Hardcoded in runtime binary (immutable at runtime)
├── 7 Primitives
├── System Tools (spec.validate, spec.register, spec.list, spec.get)
├── Layer 1 path blocklist
└── Primitive dispatch logic

Trusted files (human-controlled, OS-protected with Layer 2)
├── policy.yaml
└── tools/trusted/*.json

User-reviewed files (human-approved, agent-created)
└── tools/user-reviewed/*.json

Untrusted files (agent-created, not yet reviewed)
└── tools/untrusted/*.json
```

**System tool operations:**

| Operation | Input | Returns | What it does |
|-----------|-------|---------|--------------|
| `spec.validate` | Tool spec JSON | Validation result: valid/invalid + array of errors | Checks structure, required fields, auth config, operation definitions. Does not register the spec. |
| `spec.register` | Tool spec JSON, optional name | Spec ID + trust tier (always `untrusted`) | Validates → writes to `~/.agent/tools/untrusted/` → loads into runtime → available to future sessions |
| `spec.list` | Optional filters (trust tier, name) | Array of registered specs (name, version, tier, operation count) | Inventory of available tools across all trust tiers |
| `spec.get` | Spec ID or name | Full spec JSON | Read back a spec — useful for the agent to refine its own specs |

**The self-extension feedback loop:**

The agent can create new tool specs and iteratively refine them:

```text
User: "Can you check the weather?"
Agent: I don't have a weather tool. Let me create one.
  1. Agent reasons about what API to use (e.g. OpenWeatherMap)
  2. Agent generates tool spec JSON
  3. Calls spec.validate → gets back errors ("missing auth.token_storage_key")
  4. Fixes the spec based on validation errors
  5. Calls spec.validate again → valid
  6. Calls spec.register → spec written to untrusted dir, loaded into runtime
  7. Agent uses the new weather tool via http primitive
     (with untrusted restrictions: all mutations require approval)
  8. Agent tells user: "I created a weather tool. It's untrusted until you review it."
```

Over time, the agent improves at writing specs because it stores validation errors and successful patterns in `memory`. The feedback loop is: generate → validate → fix → register → use → remember what worked.

**Critical constraint:** `spec.register` always writes to the `untrusted` tier. The agent cannot promote its own specs to `user-reviewed` or `trusted`. Promotion requires human action outside the runtime (moving the file between directories, or a future CLI management command that the user runs directly). This ensures the trust model cannot be subverted by a determined agent.

**Security model note:**

System tools are compiled into the runtime binary. There is no JSON file describing them. There is no configuration that modifies their behavior. The agent can call them but cannot modify them, just as it can call `memory.set` but cannot rewrite the memory handler's code. This is the cleanest security boundary in the architecture — enforcement code lives below the level the agent can reach.

Layer 1 protection (runtime path blocklist, hardcoded in the binary) prevents the agent from using `file_write` or `execute` to modify the policy file, trusted spec directory, or any other protected path. Layer 2 protection (OS-level file permissions) provides the true security boundary by running the daemon as a restricted user. For v0.1, Layer 1 is implemented; Layer 2 is documented as the recommended production setup for autonomous operation.

### Communication Adapter Interface

The communication adapter is the contract between the runtime and the outside world. The runtime does not send messages to users - it sends messages to an adapter. The adapter figures out how to reach the user. This decouples `interact` completely from the delivery mechanism: WebSocket today, Telegram tomorrow, native app next year - all implement the same interface.

**The interface:**

```typescript
interface CommunicationAdapter {
  // Send a message to the user. Returns when delivered (or queued for delivery).
  send(message: OutboundMessage): Promise<DeliveryResult>

  // Register a handler for incoming user messages.
  onMessage(handler: (message: InboundMessage) => void): void

  // Is the user currently reachable?
  isConnected(): boolean
}

interface OutboundMessage {
  sessionId: string                      // which session is talking
  mode: 'ask' | 'notify' | 'approve'    // maps to interact modes
  content: string                        // always present, plain text fallback
  actions?: Action[]                     // optional quick-reply buttons
  format?: 'plain' | 'markdown'         // rendering hint to adapter
}

interface Action {
  label: string      // display text: "Yes", "No", "Snooze 30 min"
  value: string      // what gets sent back as the user's response if selected
}

interface InboundMessage {
  content: string    // what the user said (or the value from a selected action)
  timestamp: Date
}

interface DeliveryResult {
  delivered: boolean       // true if actually delivered, false if queued
  queuePosition?: number   // if queued, position in line
}
```

Three methods. That is the entire contract. Any communication channel that can implement these three things can plug into the runtime.

**What the adapter does NOT do:**

- Route messages to sessions (that is the message router's job)
- Manage the interact queue (that is the runtime's job)
- Handle timeouts (that is the session's job)
- Format messages for the LLM (that is the session model's job)

The adapter is deliberately dumb - it is a pipe. Smart pipes create coupling; dumb pipes create flexibility.

**The `actions` field:**

The optional `actions` array enables rich interaction on adapters that support it. When present, the adapter renders actions as native UI elements (buttons, selection prompts). When absent or unsupported by the adapter, the user types a free-form response and the model interprets it.

This is particularly valuable for `approve` mode - two buttons ("Yes" / "No") are dramatically better UX than requiring the user to type a response. The `content` field always serves as the plain text fallback, so the message is coherent even if actions are ignored.

**Adapter implementations:**

| Adapter | `send()` | `onMessage()` | `isConnected()` | Actions support |
|---------|----------|---------------|-----------------|-----------------|
| **WebSocket (v0.1)** | Push message over WebSocket. Buffer internally if no connection, deliver on reconnect. | Listen for WebSocket frames, parse, invoke handler. | Is there an active WebSocket connection? | Via CLI client (arrow keys + enter selection) |
| **Telegram (future)** | Call Telegram Bot API `sendMessage`. Always "delivered" - Telegram handles offline users. | Telegram webhook or long-poll -> invoke handler. | Always true (Telegram is the intermediary). | Inline keyboard buttons (native Bot API feature) |
| **Slack (future)** | Call Slack API `chat.postMessage`. Always "delivered" - Slack handles offline. | Slack Events API webhook -> invoke handler. | Always true (Slack is the intermediary). | Block Kit buttons (native Slack feature) |
| **Desktop/Mobile (future)** | Push notification + in-app message queue. | App sends message via API or WebSocket -> invoke handler. | True if app is foregrounded, false if backgrounded. | Native UI buttons |

An important semantic difference across adapters: for WebSocket, `isConnected()` reflects whether the user's client is actually connected. For Telegram and Slack, it is always true because the platform handles offline delivery. This affects the runtime's expectations but not its behavior - the interact timeout (2 minutes from delivery for triggered sessions) applies regardless.

**One active adapter at a time (v0.1):**

The adapter is configured in `config.yaml` and instantiated at daemon startup. The runtime does not support multiple simultaneous adapters in v0.1. Multi-adapter introduces routing decisions (which channel gets this message?), delivery deduplication (don't send the same reminder to CLI and Telegram), and response race conditions (user replied on both channels). All solvable, all unnecessary for a personal agent's first iteration.

Swapping adapters is a config change and daemon restart. Future versions can support multi-adapter with a routing layer on top of the adapter interface.

### Tool Spec Interpreter

The tool spec interpreter is a sub-component of the `http` primitive handler. It is the most code-dense part of the runtime: it reads a declarative JSON tool spec and translates an operation call into a fully-formed HTTP request, then maps the response back into structured data the model can understand.

**Context window management:**

Tool specs can be large. Loading every operation of every tool into the system prompt on every LLM turn would consume significant context, especially with many tools installed. The runtime uses a two-phase loading strategy:

- **Phase 1 - Manifest.** On session start, the model receives a lightweight summary of every available tool: name, description, and operation names. No parameter details, no auth config, no response schemas. This costs roughly 20-30 tokens per tool - negligible even with dozens of tools installed. Example:

```text
Available tools:
  gmail (Google Gmail API): messages.list, messages.get, messages.send, drafts.create
  github (GitHub API): issues.list, issues.get, issues.create, pulls.create, pulls.list
  weather (OpenWeatherMap): current, forecast
```

- **Phase 2 - On-demand detail.** When the model decides it needs a specific tool, it calls `spec.get(tool: "gmail")` to load the full spec (or a specific operation's definition) into context. This is a system tool call that returns the complete operation definition: parameters, auth requirements, body schema, response mapping, pagination config, and error codes.

This mirrors how a developer works: you know what tools exist, and you look up the docs when you need them. The existing system tools already support this pattern - `spec.list` serves as the manifest, and `spec.get` provides the deep dive. No additional operations are needed.

**The interpretation pipeline:**

When the model calls a tool operation (e.g., `gmail.messages.list`), the interpreter executes a six-stage pipeline:

```text
Stage 1: Spec Resolution
  -> Find the tool spec + operation definition
  -> Validate model-provided params against operation schema
  -> Check trust tier (untrusted specs flag mutations for Policy Layer approval)

Stage 2: Auth Injection
  -> Check memory for stored token (key: oauth:{tool_id}:{token_storage_key})
  -> If valid -> attach to request
  -> If expired -> refresh via token endpoint -> store new token -> attach
  -> If missing/refresh fails -> interact(mode: ask) to guide user through authorization

Stage 3: Request Building
  -> Substitute path parameters: /messages/{message_id} -> /messages/abc123
  -> Assemble query parameters: ?q=is:unread&maxResults=10
  -> Set headers from connection defaults + operation overrides
  -> Construct request body for POST/PUT/PATCH (serialize per body schema)
  -> Combine with connection.base_url to form the full request

Stage 4: HTTP Execution
  -> Execute fetch() with 30-second timeout
  -> On 429 (rate limited): read Retry-After header, wait, retry (max 3 attempts)
  -> On 503 (service unavailable): exponential backoff, retry (max 3 attempts)
  -> On 401 (unauthorized): trigger auth refresh (back to Stage 2), retry once
  -> On 2xx: proceed to response mapping
  -> On other errors: proceed to error handling

Stage 5: Response Mapping
  -> Extract fields per operation.response schema
  -> Filter response to only the fields the model needs
  -> Include pagination token if present and more pages exist

Stage 6: Error Handling
  -> Translate HTTP errors into actionable model feedback:
     400 -> "Invalid parameters: [API error message]"
     401 -> "Auth failed after refresh attempt. User may need to re-authorize."
     403 -> "Permission denied. Token may lack required scope."
     404 -> "Resource not found: [identifier]"
     429 -> "Rate limited after 3 retries. Try again later."
     500+ -> "API server error. Not an agent issue."
```

Auth injection (Stage 2) is fully transparent to the model. The model says "call Gmail" and the interpreter handles the entire OAuth2 token lifecycle - check, refresh, re-authorize. The model only sees auth when it completely fails and the user needs to intervene.

Response mapping (Stage 5) serves two purposes: it keeps the LLM context clean by filtering out fields the model doesn't need, and it provides a stable interface even if the underlying API adds new response fields.

Error handling (Stage 6) frames errors by responsibility - the model needs to know whether an error is its fault (bad parameters), the user's fault (missing permissions), or nobody's fault (server down). This framing determines the model's next action: fix parameters, ask the user for help, or retry later.

**Pagination:**

The model drives pagination, not the interpreter. When an operation returns paginated results, the interpreter returns one page plus a clear indicator: "there are more results, here's the token to fetch the next page." The model decides whether to continue by calling the same operation with the pagination token.

Auto-pagination (fetching all pages automatically) was rejected because it removes the model's control over context budget. A 50-page result set would overwhelm the context window. The model knows how much data it needs and can stop after one page or continue for ten - that is a judgment call only the model can make.

**Non-HTTP protocols (future):**

The tool spec format is currently HTTP-centric. For non-HTTP tools (local Postgres database, Redis cache, GraphQL endpoint), the v0.1 approach is to use the `execute` primitive with the tool's CLI. Most database CLIs support JSON output (`psql --json`, `sqlite3 -json`, `mongosh`, `mysql --json`), which gives the model clean structured data without any post-processing.

This works today with zero architecture changes. A future version could add a `protocol` field to the tool spec connection schema, enabling native protocol drivers in the runtime. The model's interface would not change - it would still call `local_db.query(sql: "SELECT ...")` regardless of whether the runtime uses a native Postgres driver or shells out to `psql`. This is a runtime optimization, not an architecture change.

### Policy Enforcement

The Policy Layer was defined earlier in this document — what it controls, why it exists, how it relates to `side_effects`. This section defines how it is implemented in the runtime: the file format, the enforcement gate, the approval flow, and the security boundaries.

**Policy file format:**

The policy lives in `~/.agent-policy/policy.yaml` as a flat list of rules evaluated in first-match order. Specific rules go first, catch-alls go last. Same model as iptables or nginx location blocks — the user reads the file top to bottom and knows exactly what will happen. No specificity ranking, no invisible priority conflicts.

```yaml
rules:
  # execute: allow safe read-only commands without approval
  - primitive: execute
    match: { command: ["git status", "git diff *", "git log *", "ls *", "cat *", "head *", "tail *", "wc *", "find *", "which *"] }
    action: allow

  # execute: everything else requires approval
  - primitive: execute
    action: approve

  # http: financial APIs always need human eyes
  - primitive: http
    match: { domain: "api.stripe.com", path: "/v1/charges*" }
    action: approve
    model_approval_sufficient: false

  # http: mutations on trusted tools, model can handle it
  - primitive: http
    match: { method: [POST, PUT, PATCH, DELETE] }
    action: approve
    model_approval_sufficient: true

  # http: reads are free
  - primitive: http
    match: { method: [GET, HEAD, OPTIONS] }
    action: allow

  # http: untrusted specs require approval for everything
  - primitive: http
    match: { trust_tier: untrusted }
    action: approve
    model_approval_sufficient: false

  # http: default allow (user adds domain restrictions as needed)
  - primitive: http
    action: allow

  # file_write: workspace only
  - primitive: file_write
    match: { path: "~/.agent/workspace/**" }
    action: allow

  # file_write: block everything else
  - primitive: file_write
    action: block

  # file_read: allow anywhere
  - primitive: file_read
    action: allow

  # schedule: allow (policy applies at execution time anyway)
  - primitive: schedule
    action: allow
```

Each rule has three required fields and one optional:

| Field | Required | Description |
|-------|----------|-------------|
| `primitive` | Yes | Which primitive this rule applies to: `http`, `file_read`, `file_write`, `execute`, `schedule` |
| `match` | No | Conditions that must be met. If omitted, the rule matches all calls to that primitive (catch-all). |
| `action` | Yes | What to do: `allow`, `block`, or `approve` |
| `model_approval_sufficient` | No | Only applies when `action: approve`. If `true`, a recent model-initiated `interact(approve)` for the same action satisfies this gate. Default: `false`. |

Match fields vary by primitive because what you match against is fundamentally different:

| Primitive | Match fields |
|-----------|-------------|
| `http` | `domain` (glob), `path` (glob), `method` (list), `tool` (tool ID), `trust_tier` (`trusted`, `user-reviewed`, `untrusted`) |
| `file_read` | `path` (glob) |
| `file_write` | `path` (glob) |
| `execute` | `command` (glob list — matched against the full command string) |
| `schedule` | `trigger_type` (`cron`, `once`, `event`), `max_frequency` (minimum interval between fires) |

Two primitives are exempt from the policy gate entirely:

- **`interact`** — it is the safety mechanism itself. Gating it would create a paradox: you would need approval to request approval. The runtime cannot function if `interact` is blocked.
- **`memory`** — internal state management with no external side effects. Gating memory reads and writes adds friction with no safety benefit. The model reading and writing its own memory is not a risk vector.

**The default policy philosophy:** Read operations are free, write operations are gated, dangerous operations require approval. The user then layers on domain restrictions, financial gates, and rate caps for their specific tools.

The `file_read: allow` default deserves explanation. The model can read any file on disk, including potentially sensitive ones. But reading a secret is not harmful by itself — the model can only exfiltrate data through `http` or `execute`, both of which are policy-gated. If those are restricted, unrestricted `file_read` is harmless. This avoids the annoying UX of approving every file read.

**The enforcement gate:**

Every policy-gated primitive call passes through a single enforcement function before reaching the primitive handler. One gate, one audit log entry, clean separation:

```text
Session requests primitive call
  → Is primitive exempt? (interact, memory) → Yes → skip to handler
  → Policy gate evaluates rules (first match)
    → No rule matches → default allow
    → action: allow → proceed to handler
    → action: block → return denial to session, log event
    → action: approve →
        Check for valid approval receipt (see below)
        → Receipt found and model_approval_sufficient: true → proceed to handler
        → No receipt or model_approval_sufficient: false →
            Runtime constructs approval message
            → Send directly via adapter (bypasses interact queue)
            → User approves → proceed to handler, log event
            → User denies → return denial to session, log event
```

The gate's internal logic branches by primitive type to extract the right match parameters — `http` calls provide domain, method, and path; `execute` calls provide the command string; `file_write` provides the target path — but the evaluation flow is the same for all primitives.

One important detail: **policy-triggered approvals are not model-initiated `interact` calls.** They go directly through the communication adapter, bypassing the interact queue. From the model's perspective, the primitive call simply takes a bit longer to return. The model does not get a "turn" during the approval — the conversation is between the runtime and the user.

**Approval receipts (double approval prevention):**

When the model calls `interact(mode: approve)` and the user says yes, the runtime records an approval receipt in the session:

```typescript
interface ApprovalReceipt {
  timestamp: Date
  tool?: string        // e.g., "gmail"
  operation?: string   // e.g., "messages.send"
  summary: string      // the approval message the model showed the user
}
```

When the policy gate triggers an `action: approve` rule with `model_approval_sufficient: true`, the runtime checks the current session for a matching approval receipt:

1. **Same session.** Receipts do not carry across sessions.
2. **Within the last 5 minutes.** Time is the primary staleness signal. If 20 turns happened in 3 minutes, the receipt is fresh. If 1 turn happened in 10 minutes, it is stale. Context drifts with time, not turns.
3. **Same tool + operation.** The model asking "send this email?" does not pre-approve creating a calendar event. Tool ID and operation name must match.

If a matching receipt exists, the policy gate is satisfied without prompting the user again. If no match exists — or if the rule has `model_approval_sufficient: false` — the runtime asks the user directly.

The match is intentionally loose. Tool + operation is sufficient. The runtime does not attempt to match exact parameters (did the user approve sending to *this specific* email address?). That would require parsing natural language approval messages, which is brittle and error-prone. The model asked, the user said yes, the model is now doing the thing — that is sufficient for `model_approval_sufficient: true` rules. For `model_approval_sufficient: false` rules (financial operations, irreversible actions), receipts are ignored entirely.

**What the model sees:**

When policy intervenes, the model receives just enough information to adjust its behavior — not the full policy file, not the matched rule, just the outcome and a reason:

| Policy outcome | Model receives |
|----------------|---------------|
| **Blocked** | `{ success: false, error: "Policy blocked: file_write not permitted outside ~/.agent/workspace/" }` |
| **Approved by user** | Normal primitive result (model does not know approval happened) |
| **Denied by user** | `{ success: false, error: "User denied: POST to api.stripe.com/v1/charges" }` |
| **Rate limited** | `{ success: false, error: "Rate limit: max 10 emails per hour exceeded. Try again in 23 minutes." }` |

The model does not see that a policy exists, what rules are defined, or which rule matched. It sees the consequence — "you can't do that" or "the user said no" — which is sufficient for the model to adjust (try a different path, inform the user, or give up).

**Rate limiting:**

Rate caps are a special class of policy rule that track usage over time rather than evaluating a single call in isolation:

```yaml
  - primitive: http
    match: { tool: "gmail", operation: "messages.send" }
    action: rate_limit
    limit: { count: 10, window: "1h" }
```

The runtime maintains a sliding window counter per rate limit rule. Counters are stored in the SQLite database (not in-memory) so they survive daemon restarts. When a call would exceed the limit, the runtime blocks it and returns the time until the window resets.

Rate limiting is evaluated *before* the allow/block/approve rules — a rate-limited call is blocked regardless of whether other rules would allow it.

**The `execute` bypass problem:**

There is a fundamental security boundary that the policy layer cannot enforce, and it must be documented honestly.

The `execute` primitive gives the model access to the operating system. A determined model could use `execute` to bypass every other primitive's policy:

- Write a script that calls `fetch()` → bypasses `http` domain restrictions
- Write a script that writes files outside the workspace → bypasses `file_write` path restrictions
- Write a script that reads `~/.agent-policy/policy.yaml` → bypasses "agent cannot see policy"
- Chain all of the above in a single script

`execute` is a capability amplifier that collapses the entire primitive architecture into one primitive from a security perspective. The policy layer gates the primitives, but `execute` gives the model access to the OS, and the OS can do everything the primitives can do.

**This does not invalidate the policy layer.** The policy layer is valuable for:

1. **Catching honest mistakes.** The model accidentally hitting the wrong API or writing to the wrong path.
2. **Enforcing the cooperative contract.** Most models, most of the time, use the primitives as intended. The policy catches the small percentage of cases where judgment slips.
3. **Audit trail.** Every primitive call logs through the gate, creating accountability and debuggability.
4. **Efficient UX gating.** Approval for mutations, rate caps on emails — this is where the vast majority of policy value lives.

But for adversarial containment of a model actively trying to circumvent restrictions, the policy layer is necessary but not sufficient. True containment requires enforcement below the runtime:

| Layer | Stops | Does not stop |
|-------|-------|---------------|
| **Policy Layer** (runtime) | Accidental misuse, cooperative constraint violations, UX gates | Determined bypass via `execute` |
| **Layer 1 blocklist** (hardcoded) | Modifying policy file or trusted specs via `file_write` | Reading them, or using `execute` to modify them |
| **Layer 2 OS permissions** (filesystem) | Reading/writing protected files even via `execute` subprocesses | Network access, process spawning |
| **OS network policy** (iptables/firewall) | Outbound connections from the agent process to unapproved domains | Local exploits, privilege escalation |
| **Container/VM sandbox** (gVisor, Firecracker) | Nearly everything — syscall-level isolation | Nothing practical |

Each layer catches what the layer above leaks. For v0.1, the policy layer plus heavy `execute` gating plus environment sanitization (no API keys in subprocess environment) handles the realistic threat model: a cooperative but fallible personal agent. The model is not adversarial — it is helpful but makes mistakes. The policy catches mistakes.

For production autonomous operation where the model runs unsupervised for extended periods, OS-level enforcement is necessary. The architecture supports this without code changes — the daemon runs as a process, and any process can be sandboxed from below. A production deployment guide should recommend running the daemon as a restricted OS user (Layer 2), behind firewall rules that whitelist only approved API domains (network policy), and ideally in a container with limited syscall access.

The long-term direction — an "agent OS" where policy enforcement lives at the kernel level, where `execute` cannot escape the sandbox any more than a browser tab can escape Chrome's renderer process — is the real solution to this class of problem. It is also a different project entirely. This architecture designs the agent that runs on such an OS. The primitive model remains correct regardless of where the security boundary is enforced.

**Security review of tool specs (v0.2):**

An optional enhancement for the spec trust model: when an agent creates a new tool spec via `spec.register`, the runtime could pass the spec through an LLM-powered security review before accepting it. The reviewer would check for patterns that could bypass policy — operations that shell out to `curl` via `execute`, specs that access paths outside the workspace, operations whose described behavior does not match their actual HTTP calls.

This is a detection layer, not a prevention layer. It is probabilistic (the reviewer might miss things), uses the same technology as the potential attacker (an LLM reviewing an LLM's output), and adds latency and cost. It should not be relied upon as a safety boundary. But as defense-in-depth — giving the user better information when deciding whether to promote a spec from untrusted to user-reviewed — it has value. The existing trust tiers remain the mechanism; the security review is an optimization of the human review process, not a replacement for it.

### LLM Interface

The LLM interface is how the runtime talks to the model. It must be model-agnostic — Claude, GPT, Gemini, local models — while still leveraging the core capability every major provider supports: tool calling. This section defines the provider adapter pattern, how primitives and tool spec operations are presented to the model, and how the runtime manages its context budget.

**Provider adapter pattern:**

The runtime works in its own internal message format. A thin provider adapter translates between the runtime's format and the provider's API format. Each adapter has three responsibilities:

1. **Message translation.** Convert the session's message history into the provider's expected format. OpenAI uses a `messages` array with `system`/`user`/`assistant`/`tool` roles — this is the format the initial adapter targets. Anthropic uses a similar but not identical structure. Local model APIs may use prompt templates. The adapter handles these differences.

2. **Tool declaration.** Present callable functions in whatever schema the provider expects. OpenAI, Anthropic, and Google all support JSON Schema-based function declarations but with slightly different wrapper formats. The adapter translates the runtime's canonical function list into the provider-specific declaration format, including adjusting function name characters (e.g., dots in `gmail.messages.send` may become underscores for providers that restrict function name characters to `a-zA-Z0-9_-`).

3. **Response parsing.** Extract the model's text output and/or tool call requests from the provider's response format. Each provider returns tool calls differently — OpenAI uses `tool_calls` on the assistant message, Anthropic uses `tool_use` content blocks, etc. The adapter normalizes these into a uniform internal structure.

```typescript
interface LLMProvider {
  // Send a conversation turn and get the model's response
  stream(
    messages: InternalMessage[],
    tools: ToolDeclaration[],
    config: ModelConfig
  ): AsyncIterable<StreamChunk>
}

interface StreamChunk {
  type: 'text' | 'tool_call_start' | 'tool_call_delta' | 'tool_call_end' | 'done'
  content?: string           // for text chunks
  toolCall?: {
    id: string               // provider-assigned call ID
    name: string             // function name (canonical, not provider-specific)
    arguments?: string       // partial JSON for deltas, complete JSON for end
  }
}

interface InternalMessage {
  role: 'system' | 'user' | 'assistant' | 'tool_result'
  content: string
  toolCalls?: ToolCall[]     // for assistant messages that invoked tools
  toolResultId?: string      // for tool_result messages, links back to the call
}
```

The provider adapter is pure translation. It does not manage sessions, execute tools, track context budget, or make decisions. Those responsibilities belong to the session model and the core loop.

**Streaming:**

All providers implement the streaming interface. The adapter emits `StreamChunk` objects as they arrive from the provider's API. The runtime assembles them:

- **Text chunks** are forwarded incrementally to the user via the communication adapter. The user sees text appear as it is generated, not after the full response completes.
- **Tool call chunks** are accumulated until `tool_call_end`. The runtime does not begin executing a tool call until the complete function name and arguments are received. Partial tool calls are meaningless.
- **Multiple tool calls** in a single response are supported — the model may request several primitive calls in one turn (e.g., read a file and search memory simultaneously). The runtime accumulates all tool calls, then executes them (sequentially for v0.1, potentially parallel in the future).

Streaming is the only interface. There is no separate request-response path. A non-streaming provider is handled by an adapter that buffers the full response and emits it as chunks — the runtime's processing logic is identical either way.

**Function declarations — what the model can call:**

At session start, the runtime assembles a complete list of callable functions from three sources:

```text
Source 1: Raw primitives (always present, static)
  http(url, method, headers, body)
  file_read(path)
  file_write(path, content)
  execute(command)
  memory(operation, key, value, query, domain)
  schedule(operation, ...)
  interact(mode, message)

Source 2: System tools (always present, static)
  spec.validate(spec)
  spec.register(spec)
  spec.list()
  spec.get(tool, operation?)

Source 3: Tool spec operations (generated from installed specs)
  gmail.messages.list(query, max_results)
  gmail.messages.get(message_id, format)
  gmail.messages.send(to, subject, body, cc?, bcc?)
  github.issues.list(repo, state?, labels?)
  github.issues.create(repo, title, body, labels?, assignees?)
  ... every operation from every installed spec
```

Tool spec operations are first-class callable functions. The model calls `gmail.messages.send(to: "bob@example.com", subject: "Hello")` directly — not `http(tool: "gmail", operation: "messages.send", params: {...})`. Under the hood, when the runtime receives a tool spec operation call, it routes it through the interpreter pipeline (spec resolution, auth injection, request building, HTTP execution, response mapping, error handling). But the model does not see this indirection. To the model, `gmail.messages.send` looks and behaves like a primitive.

The raw `http` primitive remains available for ad-hoc HTTP calls that are not covered by a tool spec — one-off API calls, debugging, or operations the model discovers at runtime. It is the escape hatch for when no spec exists.

Function declarations for tool spec operations are generated directly from the spec's `operations[].params` and `operations[].body` schemas. The operation's `description` becomes the function's description. Required vs. optional parameters carry over. The model has everything it needs to call the operation correctly without consulting `spec.get` first.

`spec.get` still exists but its role shifts from "load before you can call" to "learn more if you need to." The model uses `spec.get` to inspect error codes, pagination behavior, side effects, response field details — information that helps it make better decisions, not information required to make the call. Most simple operations (send email, create issue, list items) need no `spec.get` at all. Complex operations (paginated search with many filter options, batch operations with specific error semantics) benefit from the model reviewing the full spec before proceeding.

**Mid-session function list changes:**

The function list is static for the duration of a session with one exception: if the model creates and registers a new tool spec via `spec.register` during the session, the new spec's operations are added to the function list for subsequent turns. This is rare — most sessions use existing tools. The mechanism is straightforward: on the next LLM turn after a successful `spec.register`, the runtime includes the new function declarations alongside the existing ones.

**System prompt construction:**

The system prompt is assembled at session start and remains stable for the session. It contains:

```text
1. Base instructions (agent personality, behavioral guidelines, capabilities overview)
2. Current date/time and timezone
3. Policy summary: what the agent broadly can and cannot do (without revealing specific rules)
   Example: "You have access to Gmail and GitHub. Shell commands require user approval.
   File writes are restricted to your workspace directory."
4. Memory context: key facts about the user loaded from memory at session start
   (preferences, communication style, recent project context — if available)
5. For triggered sessions: schedule context, instruction, and prior messages
```

The function declarations are sent alongside the system prompt as structured tool definitions (not inline text). This is how every major provider expects them — as a separate `tools` parameter, not embedded in the prompt. The provider adapter handles the formatting.

Note item 3: the agent receives a *summary* of what it can and cannot do, not the policy rules themselves. The runtime generates this summary from the policy file at session start. This gives the model enough awareness to avoid futile attempts (it will not try to write files outside the workspace if told it cannot) without revealing the enforcement mechanism.

**Context budget management:**

The runtime tracks approximate context usage per session using character-based estimation (4 characters ≈ 1 token). This is intentionally rough — precise token counting is provider-specific, requires tokenizer libraries, and the estimation only needs to be directionally correct for budgeting decisions.

The runtime tracks three components:

```text
Context budget = model's context limit (from config, e.g. 200k tokens)

Usage = system prompt tokens
      + function declaration tokens
      + message history tokens (all turns: user + assistant + tool results)

Utilization = usage / budget
```

**Compaction threshold: 75% utilization.** When estimated usage exceeds 75% of the context budget, the runtime triggers compaction before the next LLM turn:

```text
Compaction process:
  1. Split message history into "keep" (most recent messages) and "compact" (everything older)
     Keep window: messages from the current task exchange (heuristic: last 6-10 messages,
     or everything after the most recent user message, whichever is larger)
  2. Send a summarization request to the model:
     "Summarize the conversation so far. Preserve: current task state, key decisions made,
      facts learned about the user, any pending actions or commitments."
  3. Replace the compacted messages with a single summary message
  4. Continue the session with the reduced history
```

The compaction call itself costs one model turn and some tokens, but it reclaims far more than it costs. A session that has been running for 30+ turns with large tool results (file contents, API responses) might be at 80% utilization; after compaction, it drops to 30-40%.

**Hard ceiling: 90% utilization.** If after compaction the session is still above 90%, the runtime ends the session with a message to the user: "This conversation has grown too large. Starting a fresh session." The summary from the compaction attempt is stored in memory so the next session can pick up context if needed.

The 75%/90% thresholds leave a 25% buffer for the model's response and any tool results from the current turn. Models need room to generate — a context window stuffed to 100% leaves no space for output tokens.

**Model configuration:**

The provider, model, and parameters are set in `config.yaml`:

```yaml
llm:
  provider: openai               # OpenAI-compatible (OpenAI, Minimax, Together, Groq, etc.)
  model: gpt-4o                  # provider-specific model ID
  base_url: https://api.openai.com/v1  # optional — defaults to OpenAI, set for other providers
  context_limit: 128000          # tokens — must match the model's actual limit
  max_output_tokens: 8192        # per-turn output limit
  temperature: 0                 # 0 for deterministic tool use, adjust for creative tasks
  api_key_env: OPENAI_API_KEY    # environment variable name (not the key itself)
```

The `base_url` field enables any OpenAI-compatible provider. For example, Minimax would use `base_url: https://api.minimax.chat/v1` with `api_key_env: MINIMAX_API_KEY`. The adapter code is identical — only the config changes.

The `api_key_env` field stores the name of the environment variable containing the API key, not the key itself. The config file can be safely committed or backed up without exposing credentials. The runtime reads the actual key from the environment at startup.

Swapping providers is a config change and daemon restart. The session model, primitive handlers, policy enforcement, and everything else remain unchanged — only the translation layer differs.

### State Management

Every piece of state in the runtime lives in exactly one place. This section is a consolidation — most storage decisions were made in the sections above. The purpose here is to provide the definitive map so that nothing falls through the cracks during implementation.

**In-memory (process lifetime, lost on restart):**

| State | Owner | Notes |
|-------|-------|-------|
| Active sessions | Session manager | Message history, approval receipts, context budget estimate. Lost on restart — sessions are short-lived (10-min inactivity timeout) and anything worth remembering is stored in memory. |
| Loaded policy rules | Policy engine | Parsed from `~/.agent-policy/policy.yaml` at startup. Reloaded on daemon restart, not hot-reloaded. |
| Loaded tool specs | Spec registry | Parsed from JSON files at startup. Function declarations generated from specs. Updated in-memory if model registers a new spec mid-session. |
| Communication adapter state | Adapter | WebSocket connections, internal message buffers. Reconnection is the client's responsibility. |
| Scheduler next-tick state | Scheduler | The in-memory priority queue of upcoming fires. Rebuilt from SQLite on startup. |

**SQLite (persistent, single file `~/.agent/agent.db`):**

| State | Table/Index | Notes |
|-------|-------------|-------|
| Memory store | `memory` table + FTS5 index | All domains, keyed and fuzzy access. The model's long-term knowledge. |
| Schedule store | `schedules` table | All triggers, CRUD, `next_fire_at`, `last_fire_status`. The scheduler's source of truth. |
| Rate limit counters | `rate_limits` table | Sliding window counters per policy rate limit rule. Must survive restarts — a daemon restart should not reset "10 emails per hour" to zero. |
| Compaction summaries | `memory` table (same as memory store) | Stored as regular memory entries. See below. |

**Filesystem (persistent, individual files):**

| State | Location | Notes |
|-------|----------|-------|
| Tool spec files | `~/.agent/tools/{trusted,user-reviewed,untrusted}/` | JSON files. Trust tier determined by directory. |
| Runtime config | `~/.agent/config.yaml` | LLM provider, model, timezone, communication settings. |
| Policy config | `~/.agent-policy/policy.yaml` | Separate directory. Layer 1 + Layer 2 protected. |
| Logs | `~/.agent/logs/agent.log` | Structured JSON. Includes policy enforcement audit entries. |
| PID file | `~/.agent/agent.pid` | Prevents double-launch. Removed on clean shutdown. |

**Nowhere (ephemeral, exists only during processing):**

| State | Lifetime | Notes |
|-------|----------|-------|
| HTTP responses | Single primitive call | Consumed by the interpreter, mapped to structured result, then discarded. The full API response body is not stored. |
| Subprocess output | Single primitive call | Captured from stdout/stderr, returned to session, then discarded. |
| LLM streaming chunks | Single model turn | Assembled into complete messages (text + tool calls), then discarded. |
| Auth token refresh intermediates | Single auth flow | Temporary state during OAuth2 refresh. Final token is stored in memory; intermediate states are not. |

**Compaction summaries:**

When the context budget manager triggers compaction (at 75% utilization), the runtime summarizes the conversation history and stores the summary in the memory system. This uses a simple convention, not a special subsystem:

- **Key:** `session_summary:{ISO 8601 timestamp}`
- **Domain:** `null` (cross-tool, general context)
- **Content:** The summary text the model generated during compaction

This is a regular memory entry. It is searchable via `memory.search`, discoverable via `memory.list`, and subject to the same FTS5 ranking as everything else. When a new session starts and the agent wants to pick up context from a prior conversation, it searches memory and these summaries surface naturally alongside user preferences, project notes, and other stored knowledge.

No special session history subsystem, no rewind API, no branching model. The memory system already handles persistent, searchable, time-ordered text. Compaction summaries are just another use of it. If future versions need richer capabilities — conversation branching, replay from checkpoints, structured audit trails — the data is already there as timestamped entries in memory. The storage format does not need to change; only the tooling built on top of it would.

**One important distinction:** compaction summaries are *runtime-initiated* memory writes, not model-initiated. The model did not call `memory.set` — the runtime wrote to memory as a side effect of context management. This means the memory store contains entries the model did not explicitly choose to create. The model can read, search, and even delete these entries like any other memory, but it should be aware they exist. The system prompt includes a note: "Your memory may contain conversation summaries from prior sessions, created automatically by the runtime."

**What is NOT persisted:**

Session message histories are deliberately not stored in SQLite or on disk. Sessions are short-lived — the 10-minute inactivity timeout ensures they do not accumulate indefinitely, and triggered sessions end as soon as the model's task completes. The compaction summary captures anything worth preserving from a long session. Raw message histories would be large, rarely useful after the session ends, and redundant with the summary.

If a future version needs full conversation replay (for debugging, auditing, or compliance), the path is straightforward: write message history to a separate log table in SQLite on session end. The architecture supports this addition without changes to the session model or any other component. It is omitted from v0.1 because it adds storage cost with no clear benefit for a personal agent.

---

## What This Architecture Does NOT Cover (Yet)

1. **Multi-agent coordination** — Two agents working on related issues. Who arbitrates merge conflicts? This architecture is single-agent.
2. **Streaming/real-time** — WebSocket connections, SSE streams. `http` is request-response. Real-time may need a primitive or may be handled through `execute` running a long-lived process.
3. **Binary/media operations** — Image generation, audio processing, video editing. These may need `execute` with specific runtimes or a dedicated primitive.
4. **Cost tracking** — API calls cost money. There's no primitive for budget awareness. Could be middleware on `http`, or a concern of the orchestration layer.
5. **Rollback** — If the PR is bad, how does the agent learn from the failure? `memory` captures the outcome, but automated rollback isn't defined.

These are candidates for future exploration, not immediate concerns.

---

## Open Questions

### Resolved

2. **How does auth flow work in practice?** → **Resolved.** Auth is middleware on the `http` primitive. OAuth2 token lifecycle (check → refresh → re-authorize via `interact`) is handled automatically by the runtime based on the auth section in the tool spec. See the tool spec format doc for the full decision tree.

5. **Where do tool specs live?** → **Partially resolved.** Trusted specs live in a designated directory (e.g., `~/.agent/tools/trusted/`). Agent-generated specs start as Untrusted and can be promoted. Full spec discovery (registries, auto-generation from OpenAPI, etc.) is a v0.2 concern.

### Still Open

1. **Should `execute` have sub-modes?** (e.g., `execute.shell` vs `execute.python` vs `execute.sandbox`) Or is the command string sufficient? Leaning toward command string + sandbox config being enough, but needs stress testing with complex scenarios.

3. **Memory knowledge domain schemas.** → **Partially resolved.** The memory system now supports keyed (exact) and fuzzy (FTS5) access modes, with `memory_keys` declared in tool specs. The broader question of whether domains need formal schemas describing *what to track over time* (food preferences, allergies, order history) was deferred — the model can decide what to store without a formal schema. Revisit if recall quality is poor in practice.

4. **Should `interact` support multi-user?** (e.g., asking a teammate for code review, not just the primary user) Current design assumes single-user. Multi-user introduces routing, permissions, and context-sharing problems.
