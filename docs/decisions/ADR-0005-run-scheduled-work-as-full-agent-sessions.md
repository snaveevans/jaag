---
status: "accepted"
date: 2026-03-27
decision-makers:
  - Tyler
consulted:
  - GPT-5.4
informed: []
---

# Run scheduled work as full agent sessions

## Context and Problem Statement

The original scenarios included proactive behaviors such as grocery planning, water reminders, and anniversary follow-ups. Stress-testing those scenarios showed that scheduling was not just another trigger mechanism; it changed how the agent enters work. We needed to decide whether scheduled runs should use a special reduced workflow runtime or the same runtime contract as user-initiated work.

## Decision Drivers

* Support proactive agents without inventing a separate execution model
* Keep scheduled behavior consistent with the rest of the architecture and policy system
* Preserve inspectability and manageability of future commitments
* Avoid hidden heuristics such as runtime-guessed "relevant memory" injection

## Considered Options

* Run each fired schedule as a new full agent session with normal primitive access and policy enforcement
* Use a reduced scheduled-work runtime with a narrower primitive set
* Treat schedules as predefined workflow labels that expand into special-case runtime behavior

## Decision Outcome

Chosen option: "Run each fired schedule as a new full agent session with normal primitive access and policy enforcement", because proactive behavior should reuse the same agent contract and safety model instead of introducing a second-class scheduled subsystem.

### Consequences

* Good, because scheduled work can still consult memory, use tools, and ask the user questions when needed.
* Good, because the Policy Layer applies consistently to both user-initiated and time-initiated execution.
* Good, because `workflow`, `group`, and `schedule_id` remain metadata for management rather than hidden executable definitions.
* Bad, because scheduled sessions must handle latency-sensitive interactions through async handoff rather than blocking indefinitely.
* Bad, because granting full primitive access makes policy quality even more important for autonomous runs.

### Confirmation

This decision is confirmed if scheduled triggers create inspectable schedule records, fire new sessions with current time and schedule metadata, and do not rely on a bespoke workflow interpreter. `docs/architecture.md` should continue to describe `schedule` as first-class and show the full-session execution model.

## Pros and Cons of the Options

### Run each fired schedule as a new full agent session with normal primitive access and policy enforcement

This is the chosen execution model.

* Good, because it keeps one runtime contract instead of two.
* Good, because it lets scheduled agents adapt using live memory and available tools instead of frozen workflow definitions.
* Neutral, because it still allows stricter trigger-source-aware policy rules if needed.
* Bad, because it requires the runtime to manage async continuation when human interaction outlives the triggered session.

### Use a reduced scheduled-work runtime with a narrower primitive set

This emphasizes limiting autonomous behavior.

* Good, because it appears safer at first glance.
* Neutral, because some simple reminder use cases might fit.
* Bad, because even simple scheduled tasks often need the full runtime, such as checking calendar context before notifying.
* Bad, because it would create a second execution model to explain, test, and evolve.

### Treat schedules as predefined workflow labels that expand into special-case runtime behavior

This favors a more explicit workflow engine.

* Good, because scheduled tasks could be made very deterministic.
* Neutral, because it may help with a few canned automations.
* Bad, because it reintroduces the kind of brittle orchestration layer the architecture was trying to avoid.
* Bad, because stress testing showed that the stored instruction is only the starting context, not a sufficient execution plan.

## More Information

This ADR captures the decisions that emerged from the schedule-heavy scenario stress tests, especially the proactive reminder scenarios. The resulting design is described in `docs/architecture.md`, with supporting findings in `docs/scenario-stress-test-findings.md` and original rationale in `docs/reference/old_session.md`.
