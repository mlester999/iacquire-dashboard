-- 0105_demo_registration_requests.sql — the replay ledger and the once-only first-access rule for the signed server-to-server demo registration
-- (docs/demo-external-registration.md).
--
--   * demo_registration_requests remembers a verified request id for a day. The registration route stores it before it sends any email, so a captured request cannot be
--     replayed to send a second email; the same id with the same body is answered as the caller retrying (no second email), and the same id with a different body is refused.
--     The row holds two SHA-256 hashes, never the caller's id in clear and never a body. Rows are bounded to 24 hours (the signed clock window is minutes).
--   * demo_first_access_guard makes the first-access rule a database rule as well as a service rule: once a prospect has confirmed, verified_at can never change, the window
--     can never be removed, and it cannot be shortened while the demo is still active (a Super Admin's early end, which keeps the prospect's expired/consultation/purchase
--     status, is allowed). Refresh, login, a repeat verification, a resend or a different device therefore cannot reset the 24-hour clock, whatever future code does.
--
-- Additive. Server-only: row-level security on with no policy and no grant to any role. Nothing here contacts a provider or creates a user, workspace or session.

-- ---------------------------------------------------------------------------
-- Replay ledger
-- ---------------------------------------------------------------------------

create table demo_registration_requests (
  -- sha256 of the caller's request id: the id itself is not personal data, but there is no reason to keep it.
  request_id_hash text primary key check (request_id_hash ~ '^[0-9a-f]{64}$'),
  -- sha256 of the exact body bytes that were signed, so a reused id with different content can be told apart.
  body_sha256 text not null check (body_sha256 ~ '^[0-9a-f]{64}$'),
  received_at timestamptz not null default now(),
  -- Set when the registration behind this request id was accepted. A claim that never completes (the process died between the claim and the email) is taken over after
  -- two minutes, so a retry with the same id is not lost; a fresh unfinished claim is another copy of the same request already in flight.
  completed_at timestamptz
);

create index demo_registration_requests_received_idx on demo_registration_requests (received_at);

alter table demo_registration_requests enable row level security;
revoke all on demo_registration_requests from public, anon, authenticated;

comment on table demo_registration_requests is
  'Verified request ids of the signed marketing registration, kept for 24 hours. Hashes only; no address, body or token. The route deletes expired rows as it works.';

-- ---------------------------------------------------------------------------
-- The 24-hour window is written once
-- ---------------------------------------------------------------------------

create or replace function app.demo_first_access_guard() returns trigger
language plpgsql as $$
begin
  if old.verified_at is not null then
    -- The first successful demo entry is the anchor of the 24-hour window. Nothing may move it: not a refresh, a return link, a repeat verification, a resend, a new device,
    -- a conversion or an erasure.
    if new.verified_at is distinct from old.verified_at then
      raise exception 'a demo prospect''s first access cannot be changed' using errcode = '42501';
    end if;
    if new.window_ends_at is null then
      raise exception 'a started demo cannot lose its window' using errcode = '42501';
    end if;
    -- An extension moves the end forward. A Super Admin's early end keeps the prospect where they were (expired, consultation_requested or purchase_started) and is allowed;
    -- shortening the window while the demo is still "active" would be a reset, and is refused. Ending it before it began is refused below.
    if new.window_ends_at < old.window_ends_at and new.status = 'active' then
      raise exception 'a demo window cannot be shortened' using errcode = '42501';
    end if;
    if new.window_ends_at < old.verified_at then
      raise exception 'a demo window cannot end before it started' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;

create trigger demo_first_access_guard before update on demo_prospects for each row execute function app.demo_first_access_guard();

comment on function app.demo_first_access_guard() is
  'Refuses any change to a prospect''s first access, and any shortening of the 24-hour window while the demo is active. An early end keeps the expired/CTA status and is allowed.';
