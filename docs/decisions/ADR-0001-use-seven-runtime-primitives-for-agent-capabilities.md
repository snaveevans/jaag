---
status: "accepted"
date: 2026-03-27
decision-makers:
  - Tyler
consulted:
  - GPT-5.4
informed: []
---

# Use seven runtime primitives for agent capabilities

## Context and Problem Statement

The original design work started from a concern that code-heavy agent frameworks were coupling orchestration logic to fast-changing model APIs and behaviors. We needed a smaller, more durable base interface that could support both reactive workflows and proactive agent behavior without turning every new capability into a new subsystem. The question was: what is the minimum runtime surface that still covers the intended product scenarios?

## Decision Drivers

* Keep the runtime small enough to implement, audit, and secure thoroughly
* Cover the six product-shaping scenarios without inventing ad hoc capabilities later
* Preserve clear permission boundaries between read, write, execution, memory, time, and human oversight
* Prefer adding primitives later over trying to remove them after downstream tooling depends on them

## Considered Options

* Use exactly seven primitives: `http`, `file_read`, `file_write`, `execute`, `memory`, `schedule`, and `interact`
* Use fewer primitives and merge boundaries such as read/write, notify/approval, or reactive/proactive execution
* Use more primitives and carve out dedicated capabilities such as auth, browser automation, search, or notifications

## Decision Outcome

Chosen option: "Use exactly seven primitives: `http`, `file_read`, `file_write`, `execute`, `memory`, `schedule`, and `interact`", because it covered all six scenarios while preserving the important trust and execution boundaries that would be lost in a smaller set.

### Consequences

* Good, because the architecture has a stable and teachable core surface that maps cleanly to permissioning and runtime enforcement.
* Good, because `schedule` remains first-class, which supports proactive agent behavior instead of limiting the system to request-response workflows.
* Good, because `file_read` and `file_write` stay separate, which lets the runtime grant inspection without mutation.
* Bad, because some operations will feel broad or overloaded, especially `execute`, and will need strong sandboxing and policy controls.
* Bad, because future needs such as browser automation or richer event infrastructure still require higher-level tooling built on top of the primitives.

### Confirmation

This decision is confirmed if the documented scenarios continue to map cleanly onto the seven primitives without introducing an eighth core primitive. `docs/architecture.md` and `docs/scenarios.md` should remain consistent with this set, and new capabilities should first be evaluated as compositions on top of the existing primitives.

## Pros and Cons of the Options

### Use exactly seven primitives: `http`, `file_read`, `file_write`, `execute`, `memory`, `schedule`, and `interact`

This is the chosen core runtime contract.

* Good, because it is small enough to reason about and large enough to cover the intended scenarios.
* Good, because each primitive represents a distinct category of power and therefore a distinct policy boundary.
* Neutral, because it assumes higher-level tools and workflows will be built declaratively on top.
* Bad, because the runtime must do careful work around sandboxing, scheduling, and human approval to make the surface safe.

### Use fewer primitives and merge boundaries such as read/write, notify/approval, or reactive/proactive execution

This favors maximal simplicity in the interface.

* Good, because the core API would look even smaller on paper.
* Good, because it reduces the number of primitive implementations.
* Bad, because it collapses important safety distinctions, especially between reading and mutating or between reactive and proactive behavior.
* Bad, because merged primitives would push complexity into policy and prompt logic instead of making runtime boundaries explicit.

### Use more primitives and carve out dedicated capabilities such as auth, browser automation, search, or notifications

This favors specialized capabilities at the primitive layer.

* Good, because some workflows might be easier to model directly.
* Neutral, because it could reduce some composition burden for common tasks.
* Bad, because it expands the trusted runtime surface early and makes later simplification unlikely.
* Bad, because several candidate primitives were better treated as middleware or thick tools rather than foundational syscalls.

## More Information

This ADR is reconstructed from `docs/reference/old_session.md`, especially the discussion that converged on exactly seven primitives and explicitly defended `schedule` and the `file_read`/`file_write` split. The current elaboration of the decision lives in `docs/architecture.md`.
