---
status: "accepted"
date: 2026-03-27
decision-makers:
  - Tyler
consulted:
  - GPT-5.4
informed: []
---

# Describe tools declaratively and handle auth as runtime middleware

## Context and Problem Statement

The design work began with a critique of framework-heavy agents: orchestration code was being rewritten whenever model behavior or tool APIs changed. We wanted a way for models to use tools through durable interface descriptions instead of bespoke SDK glue, while still handling real-world API authentication such as OAuth2. The question was how much of this should live in specs, how much in the model, and how much in the runtime.

## Decision Drivers

* Reduce coupling to framework-specific orchestration code
* Make tools understandable to both the model and the runtime from one source of truth
* Support common API auth patterns without introducing a separate auth primitive
* Focus v0.1 on API-backed integrations that offer the best value-to-complexity ratio

## Considered Options

* Use declarative tool specs and treat auth as runtime middleware on `http`
* Build tools mainly as hand-coded integrations with imperative orchestration logic
* Add auth or browser automation as first-class primitives in the core runtime

## Decision Outcome

Chosen option: "Use declarative tool specs and treat auth as runtime middleware on `http`", because it preserves a thin runtime, keeps tool interfaces portable, and handles OAuth2 as a repeatable pattern instead of a custom integration per service.

### Consequences

* Good, because tools become durable configuration artifacts the model can read directly.
* Good, because auth lifecycle management can be centralized and applied consistently before every request.
* Good, because Tier 1 and Tier 2 web interactions (API key, bearer token, OAuth2) cover most early use cases without a browser-heavy stack.
* Bad, because the runtime must interpret specs correctly and reliably, especially around auth, pagination, and error handling.
* Bad, because browser-only workflows remain deferred and require a later thick-tool solution rather than immediate native support.

### Confirmation

This decision is confirmed if tool examples remain expressible through `docs/tool-spec-format.md`, if OAuth2 flows are described declaratively instead of per-tool code, and if new API integrations can be added primarily by authoring or generating specs rather than writing bespoke orchestration.

## Pros and Cons of the Options

### Use declarative tool specs and treat auth as runtime middleware on `http`

This is the chosen approach for external integrations.

* Good, because the model receives `description`, `when_to_use`, request shape, and important response fields in one place.
* Good, because auth becomes a reusable runtime concern instead of being repeated in every operation definition.
* Neutral, because tool authors still need to provide enough structure for the runtime to execute requests safely.
* Bad, because the spec interpreter becomes a critical part of the runtime contract.

### Build tools mainly as hand-coded integrations with imperative orchestration logic

This matches many existing agent frameworks.

* Good, because implementation behavior can be very explicit and testable.
* Neutral, because complex edge cases can sometimes be encoded directly in code.
* Bad, because the design was explicitly reacting against this brittleness and maintenance burden.
* Bad, because every new integration or model shift tends to drag orchestration code along with it.

### Add auth or browser automation as first-class primitives in the core runtime

This would move more behavior into the primitive layer.

* Good, because some common cases could become easier to call directly.
* Neutral, because it front-loads support for a few difficult integration categories.
* Bad, because auth decomposed cleanly into `http` + `memory` + `interact`, so a dedicated primitive was not justified.
* Bad, because browser automation was judged important but not foundational for v0.1, and would add substantial runtime weight too early.

## More Information

This ADR captures the decisions from `docs/reference/old_session.md` around declarative tool specs, the OAuth2 workflow, and explicitly parking browser-first web automation for later. The current spec details live in `docs/tool-spec-format.md`, and the architectural framing lives in `docs/architecture.md`.
