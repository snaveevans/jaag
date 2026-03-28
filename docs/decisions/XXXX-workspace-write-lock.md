---
status: accepted
date: 2026-03-27
decision-makers: Tyler, AI brainstorming partner
---

# Workspace Write Lock

## Context and Problem Statement

With multiple concurrent sessions (CLI + Telegram, or multiple CLI connections), two sessions could attempt to write files or execute commands simultaneously, causing workspace interference. The question is how to prevent concurrent workspace mutations without over-engineering a locking system.

## Decision Drivers

* Single-user system — contention is rare, this is a safety net not a throughput problem
* Reversible decision — easy to upgrade to finer-grained locking later if needed
* Defense in depth — the lock is one layer; channel primitive restrictions and system prompt instructions are additional layers
* Sessions may be mid-work when connections drop — premature lock release risks data corruption

## Considered Options

* Per-file locking
* Workspace-level boolean write lock
* System prompt instructions only (no enforcement)
* Channel-based restrictions only (Telegram can't write, CLI can)

## Decision Outcome

Chosen option: "Workspace-level boolean write lock", because it's the simplest mechanism that prevents the worst case (two sessions writing to the same file), and it's trivially upgradeable later.

**How it works:**
- Lock is acquired lazily — only when a session first calls `file_write` or `execute`
- Lock is held for the session's entire duration
- Lock is released on session termination (not on disconnect — sessions may be mid-work)
- Blocked sessions get a clear error message identifying the lock holder and suggesting the `sessions` primitive to check on it

### Consequences

* Good, because it's simple — a single boolean, easy to reason about and debug
* Good, because it prevents the worst case of concurrent file mutations
* Good, because the error message guides the user toward useful action (check what's running)
* Bad, because a long-running CLI coding session blocks ALL writes from other sessions, even to unrelated files
* Bad, because it's coarser than necessary — but acceptable for single-user

### Confirmation

If a second session attempts `file_write` or `execute` while the lock is held, it receives an error result (not a crash). The error includes the lock holder's channel and start time. The first session's work is never interrupted.

## Pros and Cons of the Options

### Per-file locking

* Good, because non-conflicting writes can proceed in parallel
* Bad, because it's dramatically more complex: lock management, deadlock detection, lock expiry, partial release
* Bad, because the current use case (single user, one coding session at a time) doesn't justify the complexity

### Workspace-level boolean write lock

* Good, because it's a single boolean — simplest possible implementation
* Good, because it's easily reversible if finer granularity is needed later
* Bad, because it's a blunt instrument — blocks unrelated file writes

### System prompt instructions only

* Good, because zero implementation cost
* Bad, because there's no enforcement — a single LLM failure could corrupt the workspace mid-session
* Bad, because it relies entirely on LLM compliance, which is probabilistic

### Channel-based restrictions only

* Good, because it handles the primary case (Telegram can't write)
* Bad, because it doesn't handle two CLI sessions, or scheduled sessions that write files

## More Information

Full spec in `docs/implementation/08-multi-channel-communication.md`, Section 3.6. The lock works alongside two other layers: filtered tool declarations (the LLM on restricted channels never sees `file_write`/`execute`) and dispatch-level channel restriction checks.
