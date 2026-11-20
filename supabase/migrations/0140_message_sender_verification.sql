-- Persist proof for the specific inbound message so recovery workers never infer it from an older verified contact identity.
-- Historical email messages have no per-message authentication record and remain unknown (false). Non-email provider events and
-- web-chat sessions were already authenticated by their signed provider webhook or session token, so their inbound history is retained.
alter table conversation_messages add column sender_verified boolean not null default false;

update conversation_messages m
set sender_verified = true
from conversations c
where c.id = m.conversation_id and c.org_id = m.org_id
  and m.direction = 'inbound' and c.channel <> 'email';
