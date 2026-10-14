-- Client-facing capability copy must not claim live access that depends on an integration.
-- The Appointment Setter only sees real availability once the tenant's calendar is connected.
update agent_roles
set capabilities = '["Uses real availability once your calendar is connected", "Prepares booking requests for your approval", "Confirmation, cancellation and rescheduling support", "Appointment status lookups"]'
where key = 'appointment_setter';
