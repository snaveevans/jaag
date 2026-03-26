# Scheduled trigger execution can still fail when a schedule fires

- Status: open

## Symptom

- Schedule creation succeeds.
- The failure still appears later when the scheduled item actually fires and enters the triggered-session path.
- The end-to-end schedule plus `interact(mode: notify)` flow is still not reliable enough to call fixed.

## Reproduction outline

1. Create a schedule whose instruction will reach `interact(mode: notify)` when it runs.
2. Confirm schedule creation succeeds and the schedule is stored for a future fire time.
3. Wait for the scheduler to fire the item through the normal triggered-session path.
4. Observe that the triggered execution can still fail when the schedule fires, even though creation worked.

## Known

- Schedule creation works.
- We already fixed one concrete provider serialization bug where assistant tool-call content was sent as `""` instead of `null`.
- That fix addressed a real failure mode, but it did not fully resolve the end-to-end triggered-session failure.

## Unknown

- The remaining root cause in the fired scheduled-session path is still not isolated.
- It is not yet confirmed whether the remaining failure is in runtime triggered-session handling, provider translation, or the boundary between them.

## Workaround

- Use manual or dispatcher-level testing to validate schedule creation behavior.
- Avoid relying on triggered `interact` execution for demos until this path is fixed.

## Likely touchpoints for a future fix

- runtime triggered-session path
- provider translation for triggered runs
- schedule-fire to session-bootstrap to `interact(notify)` execution boundary
