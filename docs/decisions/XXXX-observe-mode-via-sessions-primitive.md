---
status: accepted
date: 2026-03-27
decision-makers: Tyler, AI brainstorming partner
---

# Observe Mode via Sessions Primitive

## Context and Problem Statement

When a user checks in from Telegram while a CLI coding session is running, they want to know "what's happening?" The question is how to expose session state to other sessions without building a bespoke observer infrastructure.

## Decision Drivers

* The LLM is better at interpreting "what's happening?" than any fixed status format
* A primitive is the project's standard extensibility pattern — no new concepts needed
* Read-only by design — no ability to inject into or modify another session (Mode 2 explicitly deferred)
* The primitive pattern makes it available to both CLI and Telegram sessions automatically

## Considered Options

* Special observer session type
* Fixed status endpoint / dashboard
* Sessions primitive with `list` and `read` operations

## Decision Outcome

Chosen option: "Sessions primitive", because it leverages the LLM's interpretive ability and follows the project's existing extensibility pattern with zero new infrastructure.

A new `sessions` primitive with two operations:
- `sessions list` — returns summaries of all active sessions (excluding the calling session)
- `sessions read {session_id}` — returns sanitized recent messages from a target session (system prompts redacted, content truncated, tool calls reduced to names only)

The observing session is a normal agent session that happens to have access to the `sessions` tool. The LLM interprets what the user is asking ("how's the PR review going?"), decides to call `sessions.list`, then `sessions.read`, and summarizes the results naturally.

### Consequences

* Good, because the LLM provides natural-language summaries tailored to what the user actually asked
* Good, because it requires zero new infrastructure beyond a standard primitive handler
* Good, because read-only design prevents cross-session interference
* Bad, because the LLM must infer when to use the sessions tool vs. memory vs. direct file reads
* Bad, because sanitization logic (what to redact, how to truncate) requires careful design

## Pros and Cons of the Options

### Special observer session type

* Good, because it could provide real-time streaming of another session's output
* Bad, because it creates a new session lifecycle concept
* Bad, because it's less flexible — what if the user asks a follow-up question about what they're observing?
* Bad, because it's more complex to implement

### Fixed status endpoint / dashboard

* Good, because it's deterministic — same input always produces same output format
* Bad, because it requires new protocol (HTTP endpoint or WebSocket event)
* Bad, because it doesn't leverage the LLM's ability to interpret and summarize
* Bad, because fixed formats can't adapt to what the user actually wants to know

### Sessions primitive

* Good, because it follows the existing primitive pattern — no new concepts
* Good, because the LLM interprets context and provides tailored summaries
* Good, because it's automatically available to all channels
* Bad, because it depends on the LLM choosing the right tool at the right time

## More Information

Full spec in `docs/implementation/08-multi-channel-communication.md`, Section 3.5.
