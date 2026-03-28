---
status: accepted
date: 2026-03-27
decision-makers: Tyler, AI brainstorming partner
---

# Cross-Session Knowledge Persistence

## Context and Problem Statement

The agent daemon produces knowledge during sessions — what it did, what decisions were made, and why. This knowledge needs to persist across sessions and be accessible from any channel (CLI, Telegram). The question is where and how to store it so the agent gets better over time rather than starting from zero each session.

## Decision Drivers

* The agent should be able to read its own prior reasoning when encountering related decisions
* Architectural decisions must be version-controlled and reviewable in PRs
* User-specific operational preferences must travel with the agent, not the codebase
* No new infrastructure — use what already exists (files + memory primitive)

## Considered Options

* Everything in agent memory
* Everything in repo files
* Structured database
* Two-layer persistence model (repo files + agent memory)

## Decision Outcome

Chosen option: "Two-layer persistence model", because it matches the nature of the knowledge being stored — codebase decisions belong with the code, user-agent relationship knowledge belongs with the agent.

**The two layers:**

- **Repo files (`docs/decisions/`):** Architecture and codebase decisions — things a future developer (or the agent itself) needs to understand about WHY the code/system works the way it does. Version-controlled, travels with the code.
- **Agent memory (memory primitive):** Operational preferences, user working style, behavioral learning — "Tyler prefers terse commits", "route reminders to Telegram." Things specific to the user-agent relationship, not the codebase.

**Litmus test:** "Would a new developer joining the project need to know this?" If yes → repo. If it's specific to how the agent operates for this user → memory.

### Consequences

* Good, because architectural decisions are version-controlled and can be reviewed in PRs
* Good, because the agent accumulates behavioral knowledge that compounds across sessions
* Good, because it uses only existing primitives — no new infrastructure
* Bad, because it requires discipline (via system prompt) to categorize knowledge correctly
* Bad, because there's a gray zone between "codebase decision" and "preference" that requires judgment

## Pros and Cons of the Options

### Everything in memory

* Good, because it's simple — one storage mechanism
* Bad, because architectural decisions aren't version-controlled
* Bad, because decisions get buried in operational noise and can't be reviewed in PRs
* Bad, because knowledge doesn't travel with the codebase to new team members

### Everything in repo files

* Good, because everything is version-controlled and visible
* Bad, because it clutters the repo with user-specific preferences ("Tyler likes terse commits")
* Bad, because operational knowledge doesn't travel with the agent across projects

### Structured database

* Bad, because it's over-engineered for the current need
* Bad, because it adds infrastructure dependencies
* Bad, because the agent already has memory + file_write — a database adds nothing

## More Information

The agent gets better over time because it can read its own prior reasoning. When it encounters something that touches a previous decision, it finds the rationale rather than redoing analysis or making contradictory choices. This is the foundation for durable agent intelligence.
