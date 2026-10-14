# Retention programs

Migration `0024_retention.sql`. Code: `src/lib/retention.ts`, `src/server/retention/{engine,service,cancel}.ts`, `src/server/messaging/outreach.ts`,
`src/app/actions/retention.ts`, `src/components/retention/programs-panel.tsx`. Status: **Implemented locally, tested with mocks**
(`tests/retention.test.ts`, 28 tests). Nothing has been sent to a real customer; real sending is behind `GHL_WRITES_ENABLED=false`.

## The five standard programs

Every workspace gets these, all **switched off**: welcome new customers, check in after they start (day 3 and day 14), follow up after an attended
appointment, ask for feedback, and re-engage people who've gone quiet. Programs are plain-language and editable (up to 4 messages of at most
480 characters, `{name}` and `{business}` only). Welcome, check-in, follow-up and feedback are *service* messages; re-engagement is *marketing*.

## When a message can go out

A program sends only if **all** of these hold at the moment of sending, not just when it was set up:

1. It is switched on **and** approved in exactly its current wording (`approved_hash = content_hash`). Editing the words, timing, trigger or audience
   withdraws the approval. The approval is an owner approval that expires and must be renewed.
2. The workspace is active, automation is not paused, and the employee is ready.
3. The customer has consent for that purpose and is not suppressed. Marketing messages must include how to stop them.
4. The normal send gate passes (`evaluateSend`, scope `retention`): quiet hours and business hours (unless turned off), enough credit, and its **own
   frequency limits**: one allowance per customer across all programs (`max_retention_per_contact_30d`, `min_hours_between_retention`).
5. No person has taken over the conversation.

Existing customers are never enrolled retroactively: a program only enrolls people who reach its trigger *after* it is switched on. Re-engagement
enrolls at most 10 people a day (`DAILY_ENROLLMENT_CAP`) and does not re-enroll anyone for 180 days. A step that is more than 7 days overdue after an
outage or pause is skipped, not sent late.

## Stopping

The same stop conditions that end sales follow-ups end program messages (`cancelRetention`): the customer replied, opted out, a person took over,
messaging was paused, the workspace stopped. Queued messages are blocked and their credit reservations released. A booking ends re-engagement only; a
welcome or feedback request is still welcome after someone books. Each blocked or skipped step shows its plain reason on the Retention page
(`reasonText`).

## Legal and wording flags (needs your review)

The default wording and the 30-day / minimum-gap limits are starting points. Marketing consent and opt-out wording differ by country and channel
(for example the Philippines' Data Privacy Act and carrier rules, and WhatsApp template approval). Have the final text and limits reviewed before
switching any marketing program on for a real client.

## Where to look

`/retention` (programs, audiences, preview, activity). Sample data: `/dev/operations-preview?view=retention`.
