# Scheduled trigger execution could fail when a schedule fired

- Status: resolved

## Symptom

- Schedule creation succeeded.
- The failure appeared later when the scheduled item actually fired and entered the triggered-session path.
- The end-to-end schedule plus `interact(mode: notify)` flow was not reliable enough to call fixed.

## Reproduction outline

1. Create a schedule whose instruction will reach `interact(mode: notify)` when it runs.
2. Confirm schedule creation succeeds and the schedule is stored for a future fire time.
3. Wait for the scheduler to fire the item through the normal triggered-session path.
4. Observe that the triggered execution can still fail when the schedule fires, even though creation worked.

## Resolution

- The remaining gap was closed by adding end-to-end regression coverage for the full documented path:
  - persisted schedule creation
  - scheduler fire via `SchedulerService`
  - triggered runtime launch via `AgentRuntime`
  - real OpenAI-compatible request serialization / translation
  - trailing `interact(mode: notify)` completion with no final assistant text
- The regression now proves the triggered follow-up request serializes assistant tool-call content as `null` at the provider boundary and that the fired schedule completes successfully.

## Covered now

- A fired once-schedule created through the real schedule primitive can execute end-to-end through the documented notify-only path.
- Success is recorded back to the persisted schedule (`last_fire_status = 'success'`).

## Not claimed by this closure

- This does not claim blanket coverage for every triggered-session scenario or broader degraded-provider hardening work.
- Future bugs in other triggered flows should be tracked separately from this resolved notify-path defect.

## Regression reference

- `src/scheduler/service.test.ts` — `fires persisted schedules through runtime and completes notify-only runs across OpenAI translation`
