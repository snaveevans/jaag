# Canonical Scenarios

> **Purpose:** Preserve the six original product-shaping scenarios in one canonical reference so the rest of the repo can point back to the same list. Where implementation-oriented examples exist, v0.1 development workflow docs use GitHub in place of Jira.

---

## Scenario Index

| # | Scenario | Current detail level | Deeper coverage |
|---|----------|----------------------|-----------------|
| 1 | Work email triage and response | Stress-tested in depth | `docs/scenario-stress-test-findings.md` |
| 2 | Weekly grocery planning | Canonical summary only | No dedicated deeper writeup yet |
| 3 | Push back on an underspecified Jira task / GitHub issue | Stress-tested in depth | `docs/scenario-stress-test-findings.md` |
| 4 | Happy path from GitHub issue / Jira task to PR | Detailed execution trace | `docs/architecture.md` (`Scenario 4: GitHub Issue to Pull Request`) |
| 5 | Context-aware water reminder | Stress-tested in depth | `docs/scenario-stress-test-findings.md` |
| 6 | Anniversary or birthday reminder with gift suggestions | Stress-tested in depth | `docs/scenario-stress-test-findings.md` |

---

## 1. Work Email Triage and Response

The agent reads work email, understands the incoming message and the response it likely calls for with roughly 90% confidence, drafts a reply, optionally asks the user for approval, and then sends it. The key intent is not just summarization, but dependable comprehension plus safe action on the user's behalf.

## 2. Weekly Grocery Planning

The agent notices that it is Monday and time to plan groceries, recalls the family's likes and dislikes, estimates likely food consumption, accounts for what is still on hand and should be used soon or discarded, and proposes both a meal plan and the grocery items needed for the week. The key intent is proactive household planning grounded in memory and practical inventory judgment.

## 3. Push Back on an Underspecified Jira Task / GitHub Issue

The agent reads a Jira task or GitHub issue, determines that the request is too vague to execute safely, and pushes back with concrete missing details or ambiguities. The key intent is disciplined refusal to guess when requirements, UX expectations, or acceptance criteria are underspecified.

## 4. Happy Path from GitHub Issue / Jira Task to PR

This is the successful counterpart to Scenario 3: the agent reads a Jira task or GitHub issue, fully understands the instructions, UX implications, relevant code, and tests to write, implements the change, verifies it, and opens a pull request. The key intent is end-to-end execution of a bounded development task once the requirements are clear enough.

## 5. Context-Aware Water Reminder

The agent reminds the user to drink water, and can adapt that reminder to the user's current context, such as recognizing that a hiking day calls for more hydration than a normal day. The key intent is lightweight proactive support that becomes more useful when it can factor in schedule and situational context.

## 6. Anniversary or Birthday Reminder with Gift Suggestions

The agent reminds the user that an anniversary or a spouse's birthday is approaching, nudges them to buy a gift, and recommends options informed by what that person has liked in the past. The key intent is relationship-aware memory plus timely, helpful planning support.

---

These scenarios matter because together they define the product's intended shape: deep understanding, safe delegation, pushback when needed, proactive reminders, and memory-backed personalization across both work and life tasks.
