---
status: "accepted"
date: 2026-03-27
decision-makers:
  - Tyler
consulted:
  - GPT-5.4
informed: []
---

# Use SQLite plus FTS5 memory with keyed and fuzzy access

## Context and Problem Statement

The scenario work showed that memory was the hardest primitive because it had to support both exact tool-state retrieval and general long-term recall. The design needed to stay lightweight and portable, avoid unnecessary infrastructure, and still prevent catastrophic failures such as retrieving the wrong OAuth token. The question was what the first-version memory system should be and how much structure it should impose.

## Decision Drivers

* Keep memory portable and easy to inspect, back up, and move between machines
* Support exact deterministic lookups for credentials and tool state
* Support fuzzy retrieval for user preferences, historical context, and learned behavior
* Avoid introducing vector infrastructure or tagging complexity before it is justified

## Considered Options

* Use one SQLite database with FTS5, keyed and fuzzy access modes, auto-derived memory keys, and no embeddings or tags in v0.1
* Add embeddings or a vector database in v0.1 to optimize semantic retrieval early
* Split memory into separate subsystems or tables for credentials, facts, and history

## Decision Outcome

Chosen option: "Use one SQLite database with FTS5, keyed and fuzzy access modes, auto-derived memory keys, and no embeddings or tags in v0.1", because it meets the real access patterns discovered in the scenarios without adding external services or premature schema complexity.

### Consequences

* Good, because memory stays as a single portable file with no server dependency.
* Good, because exact keyed access prevents failures like fuzzy-searching for the wrong token or tool state.
* Good, because fuzzy recall can still work through FTS5 plus recency and frequency ranking.
* Bad, because semantic recall quality may eventually hit limits without embeddings.
* Bad, because unkeyed conflicting memories are managed indirectly through ranking rather than strict consistency rules.

### Confirmation

This decision is confirmed if the runtime can store tool-owned state via derived keys, store general knowledge as fuzzy memories, and satisfy scenario queries without vector infrastructure. `docs/architecture.md` and `docs/tool-spec-format.md` should continue to reflect `memory_keys`, the `oauth:{tool_id}:{token_storage_key}` pattern, and the no-tags/no-embeddings v0.1 posture.

## Pros and Cons of the Options

### Use one SQLite database with FTS5, keyed and fuzzy access modes, auto-derived memory keys, and no embeddings or tags in v0.1

This is the chosen v0.1 memory design.

* Good, because it matches personal-agent scale and keeps the operational story simple.
* Good, because it cleanly separates deterministic lookup from fuzzy recall while using one storage system.
* Neutral, because embeddings remain available later as a progressive enhancement rather than a blocked future path.
* Bad, because the model must phrase fuzzy queries well and the runtime must rank results carefully.

### Add embeddings or a vector database in v0.1 to optimize semantic retrieval early

This favors stronger semantic search from day one.

* Good, because recall for loosely related phrasing could improve.
* Neutral, because it may help if memory volume or ambiguity grows quickly.
* Bad, because it adds dependency, cost, or model-hosting complexity that the design was explicitly trying to avoid up front.
* Bad, because the expected memory scale did not justify the added system weight.

### Split memory into separate subsystems or tables for credentials, facts, and history

This favors schema specialization.

* Good, because each memory class could be optimized differently.
* Neutral, because some data types would be easier to validate strictly.
* Bad, because it fragments the mental model and complicates how the agent reasons across stored knowledge.
* Bad, because many real memories are semi-structured and do not fit cleanly into rigid buckets.

## More Information

This ADR captures the later portion of `docs/reference/old_session.md` where the memory design converged on SQLite + FTS5, two access modes, runtime-derived key prefixes, auth-specific namespaces, recency/frequency ranking, and deferring embeddings and tags. The implemented design is documented in `docs/architecture.md` and referenced by `docs/tool-spec-format.md`.
