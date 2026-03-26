# Slice 06: Execute Primitive

> **Goal:** The agent can run shell commands. This is the most dangerous primitive and the most policy-gated, but also essential for developer workflows, file operations, and non-HTTP tool access.

**Prerequisites:** Slice 01 (Skeleton), Slice 04 (Policy Enforcement — `execute` should always be policy-gated)

**Architecture references:** docs/architecture.md — Primitive Execution (`execute`), Policy Enforcement (execute bypass problem)

---

## What This Slice Delivers

1. Fully functional `execute` primitive
2. Subprocess spawning with Bun's subprocess API
3. Environment sanitization (no API keys leaked to subprocesses)
4. Working directory management
5. Timeout enforcement
6. Output capture and truncation
7. Layer 1 hardcoded blocklist for command patterns (defense-in-depth, not security boundary)

---

## Tasks

### Task 6.1: Execute Primitive Handler
- Implement:
  ```
  src/
    primitives/
      execute/
        handler.ts       # main handler
        sanitize.ts      # environment sanitization
  ```
- Handler flow:
  ```
  1. Policy gate check (already wired from Slice 04)
  2. Best-effort blocked pattern check (defense in depth):
     - Patterns like: `curl`, `wget`, `nc`, modifying crontab
     - NOT a security boundary — just catches obvious mistakes
  3. Spawn child process via Bun.spawn:
     - command: parsed from string (split by shell)
     - cwd: ~/.agent/workspace/ by default
     - if params.cwd is provided, it must still resolve within ~/.agent/workspace/
     - env: sanitized environment (see Task 6.2)
  4. Capture stdout + stderr (combined into structured output)
  5. Apply timeout: 30 seconds (default, configurable)
  6. If output > 64KB → truncate with notice
  7. Return { exitCode, stdout, stderr }
  ```

### Task 6.2: Environment Sanitization
- Build a clean environment for each subprocess:
  ```typescript
  function sanitizeEnv(): Record<string, string> {
    const clean: Record<string, string> = {}
    // Copy safe variables
    const SAFE_VARS = ['PATH', 'HOME', 'USER', 'SHELL', 'TERM', 'LANG', 'LC_ALL']
    for (const key of SAFE_VARS) {
      if (process.env[key]) clean[key] = process.env[key]
    }
    // Explicitly exclude: API keys, tokens, secrets
    // Do NOT copy: ANTHROPIC_API_KEY, OPENAI_API_KEY, etc.
    return clean
  }
  ```
- The daemon holds secrets in its own environment. Subprocesses get a stripped-down environment.

### Task 6.3: Working Directory & Timeout
- Default working directory: `~/.agent/workspace/`
- Allow model to specify `cwd` parameter, but require the resolved directory to stay within `~/.agent/workspace/`
- Timeout: 30 seconds default
- On timeout: kill subprocess, return `{ exitCode: -1, stdout: "...", stderr: "Process timed out after 30 seconds" }`

### Task 6.4: Wire into Dispatcher
- Update dispatcher to route `execute` calls to the handler
- Update LLM function declarations to include `execute` parameters:
  ```typescript
   {
     name: "execute",
     description: "Run a shell command in the execute workspace",
     parameters: {
       command: { type: "string", description: "The shell command to run" },
       cwd: { type: "string", description: "Working directory inside ~/.agent/workspace (optional, defaults to workspace)" }
     }
   }
  ```

---

## Definition of Done

1. Agent can run simple commands: "What's in the current directory?" → `execute(ls -la)` → returns listing
2. Agent can run git commands: "Show me the git status" → `execute(git status)` → returns status
3. Commands on the default policy allowlist (git status, ls, etc.) run without approval
4. Commands NOT on the allowlist trigger an approval prompt
5. API keys are NOT present in subprocess environment
6. Long-running commands are killed after 30 seconds
7. Large output is truncated at 64KB with a notice
8. Failed commands return exit code + stderr

## Testing Approach

### Unit Tests
- **Environment sanitization:** Verify API key env vars are stripped. Verify PATH/HOME are preserved.
- **Timeout:** Mock a subprocess that sleeps → verify it's killed after timeout.
- **Output truncation:** Mock a subprocess that outputs > 64KB → verify truncation.
- **Handler:** Test successful command, failed command (non-zero exit), missing command.

### Integration Tests
- Run `ls -la` → verify directory listing returned
- Run `echo "hello"` → verify stdout captured
- Run a non-existent command → verify error returned
- Run `sleep 60` → verify timeout kills it
- Verify `env` command output does NOT contain API keys

### Test Commands
```bash
bun test src/primitives/execute/  # execute handler tests
bun test --integration            # integration with real commands
```
