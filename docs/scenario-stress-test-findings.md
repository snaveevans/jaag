# Scenario Stress Test Findings

> **Purpose:** Accumulate findings from stress-testing scenarios 1, 3, 5, and 6 against the Primitive Agent Architecture and Tool Spec Format. These findings will be folded back into the main architecture and spec docs once all scenarios are complete.

---

## Scenarios Status

| # | Scenario | Status | Key Stress Point |
|---|----------|--------|-----------------|
| 1 | Email triage | **Complete** | OAuth2 Gmail spec, complex read/categorize/draft workflow |
| 3 | GitHub pushback | **Complete** | Multi-turn conflict resolution, agent disagreement |
| 5 | Water reminder | **Complete** | Proactive agent, time-based triggers, habit tracking |
| 6 | Anniversary reminder | **Complete** | Proactive agent, date awareness, creative planning |

---

## Scenario 5: Water Reminder — Findings

### Setup
"Remind me to drink water every 2 hours during work hours."

Variations tested:
- Basic: cron-triggered notification
- Adaptive: agent tracks responses, learns hydration patterns
- Schedule modification: user changes work hours, agent updates schedules
- Cross-scenario: skip reminders during calendar meetings

### Finding 5.1: No tool spec needed for pure-primitive workflows
- **Type:** Architecture validation
- **Impact:** Low (confirms design)
- **Detail:** The water reminder uses only `schedule` + `memory` + `interact`. No external API, no tool spec. This validates that tool specs are optional — primitives alone are sufficient for native agent behaviors.
- **Action needed:** None. This is working as designed.

### Finding 5.2: Null-domain memories for cross-tool knowledge
- **Type:** Design clarification needed
- **Impact:** Medium
- **Detail:** When the agent stores "user works 9am-5pm," what `domain` does it use? There's no tool ID to derive from. Current schema allows `null` domain for "system/cross-tool memories." This works but may become a problem if the agent accumulates hundreds of null-domain memories — finding specific ones relies entirely on FTS5 quality.
- **Options:**
  - A) Keep `null` domain (current behavior). Rely on FTS5.
  - B) Add a reserved `system` domain for agent-native behaviors.
  - C) Let the model choose a domain string freely for non-tool contexts (e.g., "health", "reminders").
- **Lean:** Option A for v0.1. Revisit if FTS5 recall degrades with scale.

### Finding 5.3: `workflow` field in `schedule` is undefined
- **Type:** Gap (high impact)
- **Detail:** When a cron fires at 11am, what actually happens? The `schedule` primitive has a `workflow` field and a `context` field, but we never defined what a workflow IS. Is it a label? An instruction? A reference to stored behavior?
- **Decision needed:** What is the execution model for scheduled triggers?
- **Options:**
  - A) **Minimal context.** Model gets only `context.instruction`. Cold start. Must query memory explicitly.
  - B) **Instruction + memory snapshot.** Runtime auto-loads "relevant" memories. Problematic: what counts as relevant?
  - C) **Full agent session.** Instruction-initiated, but model has all 7 primitives available, constrained by Policy Layer.
- **Lean:** Option C. A scheduled trigger should create a full agent session — same capabilities, same policy constraints. The only difference from a user-initiated session is the trigger source. The Policy Layer already handles safety.
- **Implication:** The `workflow` field becomes a human-readable label (for listing/managing schedules). `context.instruction` is what the model receives as its prompt.

### Finding 5.4: Missing `"once"` trigger type
- **Type:** Gap in `schedule` (medium impact)
- **Detail:** "Snooze 30 minutes" requires a one-shot delayed trigger. Current spec only shows `cron` (recurring) and `event` (webhook-based) trigger types.
- **Proposed addition:**
  ```json
  {
    "trigger": {
      "type": "once",
      "at": "2026-03-18T11:30:00Z",
      "description": "Snoozed water reminder"
    }
  }
  ```
- **Use cases:** Snooze, deferred actions, "remind me in 1 hour," delayed follow-ups.

### Finding 5.5: Missing schedule management operations
- **Type:** Gap in `schedule` (high impact)
- **Detail:** The agent can `create` schedules but can't `list`, `cancel`, or `update` them. When the user says "change my work hours," the agent needs to find existing water reminder schedules and cancel them before creating new ones.
- **Required operations:**
  - `list` — filter by workflow label, trigger type, etc.
  - `cancel` — by schedule ID
  - `update` — or just cancel + recreate
- **Implication:** `schedule.create` must return a `schedule_id`. All management operations reference this ID.

### Finding 5.6: Triggered sessions need full primitive access
- **Type:** Design decision (high impact)
- **Detail:** Discovered via the "skip reminders during meetings" variation. When a water reminder fires, the agent may need to check Google Calendar (via `http`) before deciding to notify. This only works if the triggered session has full primitive access, not just the ability to send a notification.
- **Confirms:** Finding 5.3 Option C is correct. Triggered sessions are full agent sessions.

---

## Scenario 6: Anniversary Reminder — Findings

### Setup
User mentions "my wedding anniversary is June 15th" either explicitly or during another conversation. Agent should proactively help plan as the date approaches.

Two trigger paths tested:
- Path A: Explicit ("remind me about my anniversary")
- Path B: Implicit (agent learns date, proactively creates schedule)

Variations tested:
- Two-week-out planning session (gift research, preference synthesis)
- Day-before reminder with status check
- Follow-up scheduling for booking confirmations
- "Cancel all anniversary reminders" group management
- Year-over-year recurrence

### Finding 6.1: Date-sensitive memories should trigger schedule creation
- **Type:** Best practice / instruction pattern
- **Impact:** Medium
- **Detail:** When the agent learns an important date (anniversary, birthday, deadline), it should both store the knowledge in memory AND create a proactive schedule. This is a model behavior pattern — the model needs to recognize "this is date-sensitive info" and take two actions. Not a new primitive, but important enough to document as a standard pattern for agent instructions.

### Finding 6.2: Schedule context is a starting prompt, not the full picture
- **Type:** Architecture validation
- **Impact:** Low (confirms design)
- **Detail:** The `context.instruction` embedded at schedule creation time may be stale by execution time. Example: user tells agent "wife got into pottery" AFTER the anniversary schedule was created. This is fine because triggered sessions have full memory access (Finding 5.3 Option C). The model queries memory at execution time for updated preferences.
- **Confirms:** Finding 5.3 (Option C — full agent session) is correct.

### Finding 6.3: Scenario richness depends on installed tool specs
- **Type:** Observation
- **Impact:** Low
- **Detail:** Without web search, calendar, or restaurant booking tool specs, the agent can only suggest and remind — it can't take action. This is intentional (capabilities are additive via tool specs), but worth noting as a toolset planning consideration. The architecture handles this gracefully — the agent adapts to available tools.

### Finding 6.4: Multi-schedule coordination for a single event
- **Type:** Gap in `schedule` (medium impact)
- **Detail:** An anniversary creates 2+ schedules (2 weeks before, day before, follow-ups). These are independent triggers with no formal relationship. If the user says "cancel all anniversary reminders," the agent needs to find and cancel them all. Reinforces Finding 5.5 (need `schedule.list`).

### Finding 6.5: Schedules need a grouping mechanism
- **Type:** Gap in `schedule` (medium impact)
- **Detail:** Related to 6.4. Schedules created for the same event/purpose should share a group label so they can be managed together. Example:
  ```json
  {
    "primitive": "schedule",
    "operation": "create",
    "group": "anniversary_2026",
    "trigger": { ... }
  }
  ```
  Then `schedule.cancel(group: "anniversary_2026")` cancels all related schedules at once. Without this, group cancellation requires: list all → filter → cancel each.

### Finding 6.6: `once` trigger type confirmed needed
- **Type:** Confirmation of Finding 5.4
- **Detail:** "Remind me in 3 days to confirm the pottery class booking" requires a one-shot delayed trigger. Second scenario confirming this need.

### Finding 6.7: Triggered sessions need current date/time awareness
- **Type:** Design clarification needed (medium impact)
- **Detail:** A recurring cron `"0 9 1 6 *"` fires every June 1st. But the model in the triggered session needs to know the current year to give appropriate context ("your anniversary is in 2 weeks" — which anniversary? 2026? 2027?). The runtime should inject the current timestamp into every triggered session's context.
- **Action needed:** Define that the runtime always provides current date/time to triggered sessions (and arguably to all sessions).

---

## Scenario 1: Email Triage — Findings

### Setup
"Go through my inbox and help me deal with my emails."

Phases tested:
- OAuth2 auth flow → inbox access
- Bulk message fetching (50 unread emails)
- Multi-category triage with structured presentation
- Draft reply workflow with approval
- Archive/organize operations
- Learning preferences over time

### Finding 1.1: Batch fetching not in Gmail spec
- **Type:** Spec completeness issue (low impact)
- **Impact:** Low
- **Detail:** If inbox has 50 unread emails, the agent makes 50 individual `messages.get` calls. Gmail's API has batch endpoints (`messages.batchGet`, `messages.batchModify`) that our spec doesn't include. This is a spec authoring gap, not an architecture gap. The model can also be smart about fetching incrementally (first 10, triage, then more).
- **Action needed:** Add batch operations to Gmail spec when fleshing it out. Consider whether the spec format itself needs a "batch" pattern.

### Finding 1.2: Gmail spec missing modify/archive operations
- **Type:** Spec completeness issue (medium impact)
- **Impact:** Medium
- **Detail:** Archiving emails requires `messages.modify` (remove INBOX label). Our Gmail spec only has `list`, `get`, and `send`. For email triage, we also need: `messages.modify` (change labels), `messages.trash`, and possibly `messages.batchModify`.
- **Action needed:** Add these operations to Gmail spec. Not an architecture issue.

### Finding 1.3: Double approval problem — model approval + Policy Layer gate
- **Type:** Design conflict (high impact)
- **Impact:** High
- **Detail:** When the model drafts an email and asks via `interact(mode: approve)` "Send this?", the user says yes. But the Policy Layer may ALSO gate `messages.send` because `side_effects.reversible: false`, causing the user to approve the same action twice. This is a friction problem that will frustrate users.
- **Options:**
  - A) Policy Layer detects recent model-initiated approval and skips. (Complex, fragile)
  - B) Model approval counts as pre-authorization. (Requires runtime matching)
  - C) Policy gates only fire when model DIDN'T ask for approval. (Runtime tracks approval history)
  - D) Accept double-tap for irreversible operations. (Annoying but safe)
  - E) Policy Layer has a "model approval sufficient" per-rule flag. User configures which operations trust the model's approval check. (Explicit, user-controlled, clean)
- **Lean:** Option E. User configures per policy rule: "For email sending, agent's approval check is sufficient." Keeps Policy Layer simple and user-controlled.

### Finding 1.4: Domain ambiguity for preference memories
- **Type:** Design clarification needed (medium impact)
- **Impact:** Medium
- **Detail:** "User prefers shorter emails" — is this `gmail` domain or null (general)? If stored as `gmail`, an Outlook tool wouldn't find it. User communication preferences are general knowledge, not tool-specific. But "last triage run was March 18" IS tool-specific.
- **Guideline needed:** Tool-specific state (operational data like last-run timestamps) uses tool domain. User preferences (behavioral patterns) should be null-domain so they're discoverable across tools.
- **Connects to:** Finding 5.2 (null-domain memory scaling). More null-domain memories = more reliance on FTS5.

### Finding 1.5: Complex interact patterns work without changes
- **Type:** Architecture validation
- **Impact:** Low (confirms design)
- **Detail:** The triage summary is a rich, multi-section, structured report with compound decision options. The user can respond with free-form instructions ("do A and C", "draft a reply saying X", "who sent that newsletter?"). All of this works within `interact` as-is — the message is a string, the response is a string, and the model's language understanding handles interpretation. No special structured response modes needed.

---

## Scenario 3: GitHub Pushback — Findings

### Setup
Agent's PR gets a review comment disagreeing with the implementation. Agent must evaluate the feedback and respond appropriately — potentially pushing back.

Trigger paths tested:
- Path A: Event trigger (webhook — deferred, needs infrastructure)
- Path B: User tells agent (realistic v0.1 path)
- Path C: Polling (cron checks open PRs)

Response cases tested:
- Case A: Reviewer is right → acknowledge, fix, learn
- Case B: Both valid → present tradeoffs, collaborate
- Case C: Reviewer is wrong → push back with evidence (or escalate to user)
- Case D: Agent unsure → escalate to user

### Finding 3.1: Memory of reasoning is crucial for pushback
- **Type:** Best practice (medium impact)
- **Impact:** Medium
- **Detail:** In Scenario 4, step 6.5 stored the *outcome* ("Successfully completed issue #127"). But for pushback, the agent needs to recall its *reasoning* ("I chose Y because Z"). Agent instructions should emphasize storing implementation reasoning, not just outcomes, so it can defend decisions later.
- **Action needed:** Update Scenario 4 guidance and/or agent instructions to store reasoning alongside outcomes.

### Finding 3.2: GitHub spec missing review operations
- **Type:** Spec completeness issue (medium impact)
- **Impact:** Medium
- **Detail:** The pushback scenario needs operations not in our GitHub spec:
  - `pulls.list_reviews` — GET reviews on a PR
  - `pulls.list_review_comments` — GET line-level review comments  
  - `pulls.create_review_comment_reply` — POST reply to a review comment
  - `pulls.create_review` — POST a review (approve, request changes, comment)
- **Action needed:** Add these operations to GitHub spec. Straightforward additions.

### Finding 3.3: Pushback confidence calibration is an instruction/model concern
- **Type:** Architecture validation
- **Impact:** Low (confirms design)
- **Detail:** The hardest part of pushback — knowing when to push back vs. accept vs. escalate — is pure model judgment, not a primitive or spec concern. The architecture correctly leaves this to the model. Good agent instructions can guide calibration: "When confidence < X or reviewer is repo owner, escalate to user."
- **No architecture change needed.** This is instruction quality.

### Finding 3.4: The `interact` escalation pattern works well
- **Type:** Architecture validation
- **Impact:** Low (confirms design)
- **Detail:** "I'm not sure what to do, here's the situation with options, what do you think?" is a natural use of `interact(mode: ask)`. The structured presentation of competing positions with options maps cleanly to a string message + free-form response. No special structured-response mode needed.
- **Confirms:** Finding 1.5 (complex interact patterns work without changes).

### Finding 3.5: Conflict resolution learning loop
- **Type:** Observation (beneficial pattern)
- **Impact:** Low
- **Detail:** When the reviewer is right (Case A), the agent stores the correction in memory. Over time, this creates a learning loop: the agent's implementation decisions improve because it remembers past review feedback. Example: "In repo X, reviewer {name} correctly pointed out that approach X is preferred over Y because [reason]." This is a key advantage of persistent memory — the agent genuinely gets better at its job.

### Finding 3.6: PR activity monitoring for v0.1
- **Type:** Design consideration (low impact)
- **Impact:** Low
- **Detail:** Without webhook infrastructure (v0.2), monitoring PR activity requires either user notification ("go check your PR") or polling via `schedule` (cron that checks open PRs for new comments). Polling works with current primitives but is wasteful. This reinforces that webhook/event subscriptions should be a priority for v0.2.

---

## Cross-Scenario Findings

Patterns that emerged across multiple scenarios (1, 3, 5, 6 — plus previously tested 2 and 4):

### CS.1: `schedule` was the most under-specified primitive
- **Evidence:** Findings 5.3, 5.4, 5.5, 5.6, 6.4, 6.5, 6.7
- **Summary:** The `schedule` primitive was defined conceptually but lacked: full CRUD operations, a `once` trigger type, a grouping mechanism, a defined execution model for triggered sessions, and date/time injection. This was the single biggest gap found across all stress tests. The Schedule System Design section now addresses all 7 findings.
- **Resolved:** Full Schedule System Design section written in architecture doc.

### CS.2: Memory is working well but needs domain guidance
- **Evidence:** Findings 5.2, 1.4, 3.1
- **Summary:** The keyed vs. fuzzy model held up. The schema worked. But the model needed guidance on: (a) when to use null domain vs. tool domain, (b) storing reasoning alongside outcomes, (c) general user preferences as null-domain. These are instruction/best-practice concerns, not schema changes.
- **Resolved:** Domain guidelines and null-domain decision documented in architecture doc.

### CS.3: `interact` is more capable than expected
- **Evidence:** Findings 1.5, 3.4
- **Summary:** Complex interaction patterns (multi-section triage reports, competing-position escalations, compound decisions) all work within the simple string message + free-form response model. No structured response types needed. The model's language understanding handles interpretation. `interact` is the most "finished" primitive.

### CS.4: Tool specs are completeness issues, not architecture issues
- **Evidence:** Findings 1.1, 1.2, 3.2
- **Summary:** Both Gmail and GitHub specs are missing operations needed for full scenario coverage. But every missing operation is a straightforward addition — the spec format handles them perfectly. This confirms the format is correct; the examples just need fleshing out.

### CS.5: The 7 primitives cover all 6 scenarios
- **Evidence:** All scenarios traced successfully
- **Summary:** No scenario required a primitive that doesn't exist. No scenario revealed that two existing primitives should be merged or that one should be split. The primitive set is validated as both necessary and sufficient for these use cases. The most stressed primitive (`schedule`) needs more design work but not a fundamentally different capability.

### CS.6: One high-severity design conflict discovered
- **Evidence:** Finding 1.3 (double approval)
- **Summary:** Model-initiated approval via `interact(approve)` can conflict with Policy Layer approval gates, causing double-prompting for the same action. The architecture now chooses the direction without specifying runtime plumbing yet.
- **Resolved:** Direction chosen (Option E — per-rule flag). Implementation deferred to runtime design.

### CS.7: Best practices for agent instructions emerging
- **Evidence:** Findings 3.1, 6.1, 1.4
- **Summary:** Stress testing revealed patterns that should be encoded in agent instructions:
  1. Store reasoning alongside outcomes (for future pushback/defense)
  2. Create schedules when learning date-sensitive information
  3. Use null domain for user preferences, tool domain for operational state
  These are not architecture changes — they're instruction patterns that make the architecture work well.

---

## Summary: All Gaps Found

| ID | Finding | Severity | Affects | Status |
|----|---------|----------|---------|--------|
| 5.1 | Pure-primitive workflows need no tool spec | Validation | Architecture | Confirmed |
| 5.2 | Null-domain memory for non-tool contexts | Medium | Memory system | **DECIDED** — null domain kept for v0.1; resolved together with 1.4 |
| 5.3 | `workflow` field undefined; execution model for triggers unclear | High | `schedule` primitive | **DECIDED** — see Schedule Design Decisions below |
| 5.4 | Missing `"once"` trigger type | Medium | `schedule` primitive | **DECIDED** — `once` trigger type included in Schedule System Design |
| 5.5 | Missing schedule CRUD (list, cancel, update) | High | `schedule` primitive | **DECIDED** — full CRUD (create, get, list, delete, update) in Schedule System Design |
| 5.6 | Triggered sessions need full primitive access | High | `schedule` + runtime | **DECIDED** — all 7 primitives, Policy Layer constrains |
| 6.1 | Date-sensitive memories should trigger schedule creation | Medium | Best practice / instructions | Document as pattern |
| 6.2 | Schedule context is starting prompt, not full picture (memory fills gaps) | Validation | `schedule` + `memory` | Confirmed (validates 5.3 Option C) |
| 6.3 | Scenario richness depends on installed tool specs | Low | Toolset planning | Observation only |
| 6.4 | Multi-schedule coordination for single event | Medium | `schedule` primitive | **DECIDED** — `group` field + batch delete in Schedule System Design |
| 6.5 | Schedules need a grouping mechanism (`group` field) | Medium | `schedule` primitive | **DECIDED** — `group` field included in Schedule System Design |
| 6.6 | `once` trigger type confirmed needed (second scenario) | Medium | `schedule` primitive | **DECIDED** — resolved with 5.4 |
| 6.7 | Triggered sessions need current date/time awareness | Medium | Runtime / `schedule` | **DECIDED** — runtime injects current date/time into all triggered sessions |
| 1.1 | Batch fetching not in Gmail spec | Low | Gmail tool spec | Spec authoring task |
| 1.2 | Gmail spec missing modify/archive operations | Medium | Gmail tool spec | Spec authoring task |
| 1.3 | Double approval: model `interact(approve)` + Policy Layer gate | High | Policy Layer + `interact` | **DECIDED** — direction chosen (per-rule "model approval sufficient" flag); implementation deferred to runtime design |
| 1.4 | Domain ambiguity for preference memories vs tool-specific state | Medium | Memory system | **DECIDED** — guideline documented: tool domain for operational state, null domain for user preferences |
| 1.5 | Complex interact patterns work without changes | Validation | `interact` primitive | Confirmed |
| 3.1 | Memory of reasoning is crucial for pushback | Medium | Best practice / instructions | Document as pattern |
| 3.2 | GitHub spec missing review operations | Medium | GitHub tool spec | Spec authoring task |
| 3.3 | Pushback calibration is instruction/model concern, not architecture | Validation | Architecture | Confirmed |
| 3.4 | `interact` escalation pattern works well | Validation | `interact` primitive | Confirmed (also confirms 1.5) |
| 3.5 | Conflict resolution creates a learning loop via memory | Low | Memory system | Beneficial emergent pattern |
| 3.6 | PR activity monitoring needs webhooks (v0.2) or polling (v0.1) | Low | `schedule` + v0.2 planning | Observation |
