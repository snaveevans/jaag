---
status: accepted
date: 2026-03-27
decision-makers: Tyler, AI brainstorming partner
---

# Memory as Cross-Session Bridge

## Context and Problem Statement

When a long-running CLI coding session finishes and the user checks in from Telegram, they want continuity — "what happened? what changed? what's next?" The question is how to bridge context between sessions on different channels without blowing context windows or building complex session-transfer machinery.

## Decision Drivers

* Context windows are finite — a real coding session generates far too much data to load raw into another session
* The completing agent has full context and is the best summarizer of its own work
* Memory already exists as a cross-session, cross-channel persistence layer
* The `sessions` primitive handles real-time observation of active sessions — this decision is about completed sessions
* Zero new infrastructure preferred

## Considered Options

* Load session history into context
* Session switching / rebinding
* Memory as bridge (with sessions primitive for real-time supplement)

## Decision Outcome

Chosen option: "Memory as bridge", because the agent that did the work is the best summarizer of the work, and memory already crosses all session/channel boundaries by design.

**The flow:**
1. Coding session finishes → agent stores summary + key decisions in memory (habit established via system prompt)
2. User asks from Telegram "what happened?" → Telegram agent reads from memory, optionally uses `sessions.read` for recent details, optionally uses `file_read` to verify workspace state
3. Full continuity, zero context-loading gymnastics

**Key insight:** "Session switching" is an illusion. What the user actually wants is continuity, not the literal session object. Memory provides continuity.

### Consequences

* Good, because it uses existing infrastructure with zero new code
* Good, because summaries are higher-quality than raw message logs (written by the agent with full context)
* Good, because it works regardless of session state (active, completed, expired)
* Bad, because it depends on the agent reliably storing summaries (system prompt instruction, not enforced)
* Bad, because if the session crashes before storing a summary, continuity is lost (mitigated by `sessions.read` for recent active sessions)

### Confirmation

Validated by the cross-channel scenario: CLI session completes a task → user queries from Telegram "what happened?" → Telegram agent retrieves the summary from memory and provides a coherent response without needing the original session's context.

## Pros and Cons of the Options

### Load session history into context

* Good, because it preserves full fidelity of the original conversation
* Bad, because a coding session can generate hundreds of thousands of tokens — doesn't fit in context
* Bad, because even truncated, most of the content is noise (raw file contents, command outputs, error traces)
* Bad, because the new session may have different channel restrictions — it's reading about actions it can't take

### Session switching / rebinding

* Good, because it preserves the exact session state
* Bad, because primitive restrictions were set at session creation based on channel
* Bad, because the system prompt was built for the original channel
* Bad, because "continuing" a completed session is semantically unclear — what does that even mean?

### Memory as bridge

* Good, because the completing agent writes targeted, high-quality summaries
* Good, because memory is already shared across all sessions and channels
* Good, because it requires zero new infrastructure — just a system prompt convention
* Bad, because the agent might forget to store summaries (mitigated by system prompt instruction)

## More Information

This decision works in concert with two others: the `sessions` primitive (for real-time observation of active sessions) and the cross-session knowledge persistence model (two-layer: repo files for architecture decisions, memory for operational knowledge). Together they provide complete cross-session, cross-channel continuity.
