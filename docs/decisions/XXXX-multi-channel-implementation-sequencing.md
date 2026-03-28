---
status: accepted
date: 2026-03-27
decision-makers: Tyler, AI brainstorming partner
---

# Multi-Channel Implementation Sequencing

## Context and Problem Statement

The multi-channel communication spec defines 10 implementation slices (A through J) covering WebSocket multi-connection, routing, session management, primitive restrictions, workspace locking, orchestration, schedule routing, CLI updates, and a Telegram gateway. The question is what order to build things in, and whether to build all 10 slices before getting user value.

## Decision Drivers

* Highest leverage first — some changes cost almost nothing and compound immediately
* Validate assumptions cheaply before committing to expensive builds
* Fix foundations before building on them — don't inherit known debt into new code
* Reversible decisions should move fast; irreversible ones deserve more thought

## Considered Options

* Build all 10 slices sequentially (A → J)
* Jump directly to Telegram gateway (Slice J)
* Three-phase approach: habit → foundation → validate thin → build full

## Decision Outcome

Chosen option: "Three-phase approach", because it delivers value at each phase and validates assumptions before committing to the full build.

**Phase 1 — Establish the decision-recording habit (days, not weeks)**
- Update system prompt to instruct the agent to record decisions (repo for architecture, memory for preferences)
- Seed `docs/decisions/` with initial ADRs
- Independent of multi-channel — starts generating durable value immediately
- The decision-recording habit makes everything else work better because cross-session continuity depends on having something worth reading

**Phase 2 — Fix foundational debt**
- Fix prompt correlation in the WebSocket protocol (identified in critic review)
- The multi-channel spec adds `identify`, connection routing, and session binding — prompt correlation fits naturally into the same protocol refactor
- Doing it before Slice A avoids touching the WebSocket message format twice

**Phase 3 — Build multi-channel, validate thin first**
- Consider shipping a thin Telegram notification bot BEFORE the full 10-slice spec
- A notification bot that watches session completions and sends summaries is ~100 lines, doesn't require multi-connection WebSocket, router, or orchestrator
- This validates the core use case ("tell me when something finishes") with minimal investment
- If interactive Telegram sessions prove necessary, the full spec (Slices A-J) is ready to build

### Consequences

* Good, because each phase delivers standalone value — nothing is wasted even if later phases are deferred
* Good, because the thin notification bot validates the real use case before investing in 10 slices
* Good, because foundational debt (prompt correlation) is fixed cleanly rather than worked around
* Bad, because the thin notification bot is a throwaway if the full spec is ultimately built
* Bad, because Phase 3's "validate thin first" delays the full multi-channel implementation

### Confirmation

Phase 1 is confirmed when the agent reliably stores decision summaries in memory and writes architectural ADRs to `docs/decisions/` without being explicitly asked. Phase 2 is confirmed when prompt replies are correlated by ID and can't be hijacked by unrelated messages. Phase 3's thin validation is confirmed when the user receives a Telegram notification after a CLI session completes and can meaningfully act on the summary.

## Pros and Cons of the Options

### Build all 10 slices sequentially

* Good, because it's the most thorough approach with full feature coverage
* Bad, because it delays value delivery — weeks of infrastructure before the first Telegram message
* Bad, because the user might discover that 90% of the value comes from notifications + memory, making interactive Telegram sessions premature

### Jump directly to Telegram gateway

* Good, because it targets the most visible deliverable first
* Bad, because Slice J depends on Slices A-G — it can't be built without the foundation
* Bad, because building on unfixed prompt correlation creates technical debt

### Three-phase approach

* Good, because it starts with the highest-leverage, lowest-cost change (habit)
* Good, because it validates assumptions cheaply before committing
* Good, because fixing foundations first prevents inherited debt
* Bad, because the thin notification bot may be partially throwaway work

## More Information

Full multi-channel spec in `docs/implementation/08-multi-channel-communication.md` (10 slices, A-J). Critic review identifying foundational debt in `reviews/critic-review.md`. The three-phase approach lets each phase inform whether the next phase is worth building.
