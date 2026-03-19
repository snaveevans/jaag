# Slice 02: Memory & File Primitives

> **Goal:** The agent can remember things across sessions and read/write files. This gives the agent persistent state and filesystem access — the foundation for all useful work.

**Prerequisites:** Slice 01 (Skeleton)

**Architecture references:** docs/architecture.md — Memory System Design, Primitive Execution (`memory`, `file_read`, `file_write`)

---

## What This Slice Delivers

1. SQLite database initialization (`~/.agent/agent.db`)
2. Fully functional `memory` primitive (get, set, search, list, delete) with FTS5 full-text search
3. Fully functional `file_read` primitive with size limits
4. Fully functional `file_write` primitive with Layer 1 hardcoded path blocklist
5. These primitives wired into the dispatcher so the model can actually call them
6. Function declarations for these primitives registered with the LLM interface

The agent will be able to: remember user preferences, store operational state, read files from disk, and write files to the workspace.

---

## Tasks

### Task 2.1: SQLite Database Setup
- Create database initialization module:
  ```
  src/
    db/
      database.ts        # database connection + initialization
      migrations.ts      # schema creation (memory table, FTS5 index)
  ```
- Using `bun:sqlite` (built-in, no external dependency)
- Create memory table:
  ```sql
  CREATE TABLE IF NOT EXISTS memory (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    domain TEXT,              -- nullable, tool-scoped or null for general
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    created_at TEXT NOT NULL,  -- ISO 8601
    updated_at TEXT NOT NULL,  -- ISO 8601
    access_count INTEGER DEFAULT 0,
    UNIQUE(domain, key)
  );

  CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
    key, value,
    content='memory',
    content_rowid='id'
  );
  ```
- FTS5 trigger setup for automatic index sync on insert/update/delete
- Database connection management (single connection, WAL mode for concurrent reads)

### Task 2.2: Memory Primitive Handler
- Implement all 5 operations:
  ```typescript
  // memory({ operation: "get", domain: "gmail", key: "last_triage" })
  // memory({ operation: "set", domain: null, key: "user_prefers_short_emails", value: "true" })
  // memory({ operation: "search", query: "email preferences", domain: null, limit: 10 })
  // memory({ operation: "list", domain: "gmail" })
  // memory({ operation: "delete", domain: "gmail", key: "old_token" })
  ```
- `get`: keyed lookup by domain + key → return value or null
- `set`: upsert by domain + key → write to SQLite, update FTS5 index
- `search`: FTS5 query with optional domain filter → return ranked results (BM25 + recency/frequency boost)
- `list`: query with optional domain filter → return entries
- `delete`: remove by domain + key → clean up FTS5 index
- Auto-prefix domain with tool ID when called in tool spec context (deferred to Slice 03 — no tool specs yet)

### Task 2.3: File Read Primitive Handler
- Implement `file_read`:
  ```typescript
  // file_read({ path: "/path/to/file" })
  // file_read({ path: "/path/to/directory" })  → returns directory listing
  ```
- Path resolution (expand `~`, resolve relative paths against workspace)
- If path is a file: read contents, truncate at 1MB with notice
- If path is a directory: list entries (files + subdirectories)
- Layer 1 blocklist check: prevent reading from protected paths (policy directory, etc.)
- Clear error messages for: file not found, permission denied, is a directory (when expecting file)

### Task 2.4: File Write Primitive Handler
- Implement `file_write`:
  ```typescript
  // file_write({ path: "~/.agent/workspace/notes.md", content: "..." })
  ```
- Path resolution (same as file_read)
- Layer 1 hardcoded blocklist:
  ```typescript
  const BLOCKED_PATHS = [
    '~/.agent-policy/',      // policy directory
    '~/.agent/tools/trusted/', // trusted specs
    '~/.agent/agent.pid',     // PID file
    '~/.agent/config.yaml',   // runtime config
  ]
  ```
- Create parent directories if they don't exist
- Return confirmation: path written, bytes written
- Clear error for blocked paths: "Write blocked: [path] is protected by the runtime"

### Task 2.5: Wire Primitives into Dispatcher
- Update `src/primitives/dispatcher.ts` to route `memory`, `file_read`, `file_write` to real handlers
- Other primitives remain as stubs
- Update function declarations sent to LLM to include parameter schemas for these three primitives

### Task 2.6: System Prompt Update
- Update the base system prompt to describe available primitives:
  - `memory`: what it stores, how search works, domain scoping
  - `file_read`: what it can read, size limits
  - `file_write`: where it can write, what's blocked
- The model should understand it can use these tools in conversation

---

## Definition of Done

1. Database file `~/.agent/agent.db` is created on first startup
2. Agent can store and retrieve values:
   - User: "Remember that I prefer dark mode"
   - Agent stores via memory.set → later retrieves via memory.search when relevant
3. Agent can search memory with natural language queries via FTS5
4. Agent can read files: "Read the contents of ~/.agent/config.yaml"
5. Agent can write files to workspace: "Create a file called notes.md in the workspace with..."
6. Agent CANNOT write to blocked paths: "Write to ~/.agent-policy/policy.yaml" → blocked
7. Memory persists across daemon restarts
8. File read truncates large files with a notice

## Testing Approach

### Unit Tests
- **Memory handler:** Test each operation (get/set/search/list/delete). Test upsert behavior. Test FTS5 search relevance (does "email preferences" find "user prefers short emails"?). Test domain scoping (gmail domain search doesn't return null-domain entries unless explicitly searching null).
- **File read handler:** Test file reading, directory listing, 1MB truncation, blocklist enforcement, missing file errors.
- **File write handler:** Test writing, parent directory creation, blocklist enforcement, blocked path error messages.
- **Database:** Test initialization, WAL mode, FTS5 index sync.

### Integration Tests
- Start daemon → connect client → ask agent to remember something → restart daemon → ask agent to recall it → verify memory persistence
- Ask agent to read a known file → verify contents returned
- Ask agent to write a file → verify file exists on disk
- Ask agent to write to a blocked path → verify rejection

### Test Commands
```bash
bun test src/db/                  # database tests
bun test src/primitives/memory/   # memory handler tests
bun test src/primitives/file/     # file handler tests
bun test --integration            # full integration tests
```
