# Appointments

Migration `0023_appointments.sql`. Code: `src/lib/appointments.ts`, `src/server/appointments/*`, `src/app/actions/appointments.ts`,
`src/components/appointments/*`. Status: **Implemented locally, tested with mocks** (`tests/appointments.test.ts`, 67 tests).

## What is real and what is not

- **The calendar is the source of truth.** The portal never invents a time. Availability comes from the connected GHL calendar's own free-slot
  response; if it can't be read, the portal says so and offers nothing.
- **Booked means confirmed.** A booking is shown as *booked* only when the provider confirms it. Otherwise it is *held* with a plain
  "add it to your calendar to finish" message (`needs_manual`). Holds expire (`expireBookingHolds`).
- **GHL writes are off** (`GHL_WRITES_ENABLED=false`). Booking through the provider is therefore disabled in every environment until the
  agency enables it deliberately for a test location. The code path exists and is tested against mocks.
- **The n8n Appointment Event Processor stays inactive.** The portal keeps its own event ledger instead and does not depend on that workflow.

## Event ledger

`appointment_events` stores provider appointment events (parsed by `parseGhlAppointmentEvent`) with a dedupe key, so a replayed webhook does
nothing. Events are applied in **provider-timestamp order**, not arrival order, under an advisory lock per appointment, so a late "scheduled" cannot
overwrite a newer "cancelled". Anything older than the current state is recorded as stale and not applied. `appointment_bookings` holds the
resulting state; `appointment_reminders` holds scheduled reminders.

## Reminders

Reminder offsets are set per workspace (`appointment_settings.reminder_offsets_minutes`; default 24 hours and 2 hours before, at most three, none
longer than 14 days). `reminderSchedule` drops offsets already in the past and collapses duplicates;
reminders are never sent late. They go through the normal messaging gate (`evaluateSend`, scope `reminder`, purpose service), so consent,
suppression, pauses, quiet hours and credits all apply. A reminder blocked only by quiet hours is queued for the next allowed time; a
permanent block cancels it with the reason recorded. Late-cancellation rules are computed with `isLateCancellation`.

## AI booking

The Appointment Setter offers only slots the calendar returned (`parseFreeSlots`, `filterSlots`), in the customer's timezone, and books only after
the customer picks one. The calendar is re-checked for that exact time immediately before booking; a time that is gone is released and the customer
is offered the calendar's current list. A booking made by an AI employee goes to **Approvals** (expires after 48 hours) unless the employee is in
Autonomous mode, no pause or emergency stop applies, **and** the owner has switched on "let my AI book without asking" in the booking policy.
Appointment **reminders** are separate: sending them automatically needs an approved, expiring standing authorization (`approval_requests` kind
`standing_authorization`) that the owner renews; an expired one is flagged on the Appointments page and reminders wait for a person.

## Holds

A booking request that was never completed is released after 15 minutes. A time held for a person to add to the calendar by hand (`needs_manual`)
is released after 24 hours. A booking waiting on an approval that was declined or expired is cancelled. Releasing a hold never contacts the customer.

## Where to look

`/appointments` (list, pending approvals, booking dialog, policy and reminder settings). Sample data: `/dev/operations-preview?view=appointments`.
