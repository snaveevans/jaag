# Critic Review: memory system design docs

**Date**: 2026-03-18
**Scope**: User-specified review of `tool_spec_format.md` and `primitive_agent_architecture.md`
**Reviewer**: AI Critic Agent

---

## Executive Summary

The requested memory-system updates are mostly present: `memory_keys` is wired into the tool spec format, the Gmail and GitHub examples were updated, the architecture doc now defines keyed and fuzzy memory access, and the fenced JSON blocks parse cleanly. The main gap is that the SQLite/FTS5 schema in `primitive_agent_architecture.md` is not actually workable as written, so the design is not fully implementation-ready yet. There are also a few smaller documentation inconsistencies around OAuth token storage and memory-domain semantics that should be cleaned up to keep the two docs aligned. This is close, but not fully complete or fully consistent.

---

## Verdict

- **Spec**: Partially met
- **Architecture**: Minor drift
- **Completion**: Incomplete
- **Merge Recommendation**: Fix major issues first

---

## Critical Issues

No critical issues found.

---

## Major Issues

### FTS5 schema is not valid for the declared UUID primary key

- **Location**: `primitive_agent_architecture.md:491`, `primitive_agent_architecture.md:503`
- **Problem**: The schema declares `id TEXT PRIMARY KEY` and then builds the FTS5 table with `content_rowid=id`. In SQLite FTS5 external-content mode, the content rowid must map to a rowid-compatible integer key. With the schema as written, FTS queries break instead of returning results. This makes the core fuzzy-memory design non-executable even though the surrounding prose says the system relies on SQLite + FTS5.
- **Recommendation**: Redesign the schema so FTS5 uses an integer surrogate rowid, for example `rowid INTEGER PRIMARY KEY` (or `memory_rowid INTEGER PRIMARY KEY`) plus `id TEXT UNIQUE` for the UUID, and point `content_rowid` at the integer column. If you want to keep UUIDs as the only identifier, then document a standalone/contentless FTS table with explicit sync triggers instead of external-content mode.

---

## Minor Issues

### OAuth refresh flow omits the derived storage key

- **Location**: `tool_spec_format.md:174`
- **Problem**: The OAuth2 decision tree correctly reads with `memory.get(oauth:{tool_id}:{token_storage_key})`, but the refresh branch writes back with `memory.store(new tokens)` instead of storing back into the same derived key. That leaves the refresh path inconsistent with the rest of the design and could mislead an implementer into treating refreshed tokens as an unkeyed write.
- **Recommendation**: Change the refresh step to `memory.store(oauth:{tool_id}:{token_storage_key}, new tokens)` or equivalent wording that explicitly says the refreshed token set overwrites the existing derived auth key.

### Auth-memory domain example conflicts with the schema rule

- **Location**: `primitive_agent_architecture.md:493`, `primitive_agent_architecture.md:596`
- **Problem**: The schema says `domain` is derived from the tool ID (examples: `gmail`, `grocery`), but the User Inspection section says OAuth tokens are listed with `list(domain: "oauth")`. Those two statements only work together if auth memories are a documented exception, and that exception is not defined anywhere.
- **Recommendation**: Pick one rule and document it explicitly. Either state that auth entries use `domain = "oauth"` as a reserved namespace everywhere, or keep `domain` derived from the tool ID and update the inspection example to use tool-specific domains or key-prefix filtering.

### Open Questions still treats the memory access model as unresolved

- **Location**: `primitive_agent_architecture.md:922`
- **Problem**: Section 5 and the Memory System Design section already resolve memory to two access modes: keyed and fuzzy. The Open Questions section still asks "Key-value? Semantic search? Both?", which reads like the design decision is unsettled even though the doc now specifies it.
- **Recommendation**: Rewrite this item so it only covers the truly open part - the domain-specific memory schema/problem definition - and remove the already-resolved access-mode framing.

---

## Strengths

- `tool_spec_format.md:27` and `tool_spec_format.md:42` now include `memory_keys` in both the top-level JSON example and the top-level field table.
- `tool_spec_format.md:196`, `tool_spec_format.md:228`, and `tool_spec_format.md:272` place the Memory Keys section in the requested position between Connection and Resources.
- `tool_spec_format.md:138` and `tool_spec_format.md:1107` use `"tokens"` for both OAuth token storage examples, and `tool_spec_format.md:151` documents the `oauth:{tool_id}:{token_storage_key}` derivation pattern.
- `tool_spec_format.md:637` and `tool_spec_format.md:1122` add the requested `memory_keys` examples for GitHub (`default_repo`, `conventions`) and Gmail (`user_email`, `signature`).
- `primitive_agent_architecture.md:142`, `primitive_agent_architecture.md:146`, and `primitive_agent_architecture.md:475` now define keyed + fuzzy memory access on SQLite/FTS5 and include the requested Memory System Design subsections.
- All fenced `json` blocks in both files parse successfully with a JSON parser, so there are no obvious comma/syntax regressions in the examples.

---

## Review Notes

The source of truth for this review was the user-provided checklist in the request. I also sanity-checked the fenced JSON blocks by parsing them and validated the FTS5 schema concern with a minimal SQLite reproduction, because the doc presents that schema as implementation guidance rather than loose pseudocode.
