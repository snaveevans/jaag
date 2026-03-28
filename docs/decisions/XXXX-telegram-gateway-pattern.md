---
status: accepted
date: 2026-03-27
decision-makers: Tyler, AI brainstorming partner
---

# Telegram Gateway Pattern

## Context and Problem Statement

The daemon needs to support Telegram as a communication channel alongside the existing CLI. The question is how to integrate Telegram support without compromising the daemon's minimalist architecture (2 runtime dependencies).

## Decision Drivers

* Project philosophy: 2 runtime dependencies, keep daemon minimal
* Separation of concerns: platform-specific translation outside the daemon
* Independent deployability: gateway can restart without affecting daemon
* The daemon's existing WebSocket protocol is already sufficient — no need to invent a new integration point

## Considered Options

* Native Telegram adapter inside the daemon
* External gateway process
* HTTP webhook approach

## Decision Outcome

Chosen option: "External gateway process", because it keeps platform-specific code entirely outside the daemon and requires zero changes to the daemon's architecture.

The Telegram Gateway is a separate Bun process that:
- Connects to the daemon over WebSocket (the daemon's existing protocol)
- Translates between Telegram Bot API and the daemon's message format
- The daemon has NO knowledge of Telegram — it just sees another WebSocket client

The gateway is ~200 lines, uses only Bun built-ins (fetch for Telegram API, WebSocket client for daemon).

### Consequences

* Good, because the daemon stays minimal with no Telegram-specific code
* Good, because the gateway can be developed, deployed, and restarted independently
* Good, because the pattern generalizes to other channels (Discord, Slack, etc.)
* Bad, because it's another process to run and monitor
* Bad, because there's a network hop between gateway and daemon (negligible for chat latency)

## Pros and Cons of the Options

### Native Telegram adapter inside the daemon

* Good, because it's a single process — simpler deployment
* Bad, because the daemon would depend on Telegram-specific logic, violating the minimalist philosophy
* Bad, because platform-specific code inside the daemon creates coupling
* Bad, because Telegram issues (rate limits, API changes) could affect the daemon

### External gateway process

* Good, because the daemon has zero knowledge of Telegram
* Good, because the gateway is ~200 lines using only Bun built-ins
* Good, because it can be independently developed, tested, and restarted
* Bad, because it's an additional process to manage

### HTTP webhook approach

* Good, because Telegram natively supports webhooks
* Bad, because the daemon would need to expose an HTTP API
* Bad, because the daemon would need to understand Telegram payloads directly
* Bad, because it mixes concerns — the daemon becomes aware of external platform formats

## More Information

Full spec in `docs/implementation/08-multi-channel-communication.md`, Section 3.7.
