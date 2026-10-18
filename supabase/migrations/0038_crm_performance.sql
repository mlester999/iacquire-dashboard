-- iAcquire Native CRM performance: tenant-scoped indexes found by measuring the CRM at realistic scale (tests/perf, docs/crm-performance.md).
--
-- Indexes only. No table, column, constraint, policy, function, grant or data changes. Every index leads with org_id, so a read for one
-- workspace never walks another workspace's rows, and each one is scanned by a CRM screen's query in the measurements (pg_stat_user_indexes
-- per call, 50,000-contact workspace):
--   * contact directory pages in their default and name orders (A to Z and Z to A), so a page (LIMIT 25..100) stops after the rows it shows
--     instead of sorting the whole workspace;
--   * report periods over messages and delivery events (these two had no index leading with org_id; the planner uses them once the per-row
--     policy calls described in docs/crm-performance.md are gone, and reads through the conversations join until then);
--   * calendar windows and slot computation, by when a block or appointment ends, so a busy person's years of history are not walked to
--     find next week's free time.
-- Three candidates were measured and left out because no query scanned them: (org_id, tag_id, contact_id) on crm_contact_tags (the existing
-- (org_id, tag_id) index serves the tag filters), a board-order index on crm_opportunities (the board ranks after filtering on status, so
-- it reads the pipeline's deals either way), and (org_id, user_id, ends_at) on crm_external_busy (calendar sync keeps only yesterday onwards,
-- so the existing starts_at index is already bounded).
--
-- Hosted rollout: the migration runner applies a file in one transaction, where CREATE INDEX CONCURRENTLY is not allowed, so these are plain
-- CREATE INDEX statements (they block writes to the table while they build). On large hosted tables, build them beforehand with
-- CREATE INDEX CONCURRENTLY under the same names and definitions; IF NOT EXISTS then leaves them as they are.
-- Rollback: supabase/rollbacks/0038_crm_performance.down.sql (drops exactly these indexes).

-- ---------------------------------------------------------------------------
-- Contact directory
-- ---------------------------------------------------------------------------

-- listContacts' default order (newest first; "desc nulls last, id desc" exactly as contactOrderBy writes it) over live, unarchived contacts.
create index if not exists contacts_directory_recent_idx on contacts (org_id, created_at desc nulls last, id desc)
  where deleted_at is null and archived_at is null;

-- The name order (contactOrderBy's lower(nullif(display_name, '')) ascending, nulls last, then id).
create index if not exists contacts_directory_name_idx on contacts (org_id, lower(nullif(display_name, '')) asc nulls last, id asc)
  where deleted_at is null and archived_at is null;

-- The name order Z to A, which is what the Sort menu's first click on Name sends (dir=desc; a second click gives A to Z). contactOrderBy puts
-- nulls last in both directions, and reading the index above backwards gives "desc nulls first", so one index cannot serve both orders.
create index if not exists contacts_directory_name_desc_idx on contacts (org_id, lower(nullif(display_name, '')) desc nulls last, id desc)
  where deleted_at is null and archived_at is null;

-- ---------------------------------------------------------------------------
-- Reports
-- ---------------------------------------------------------------------------

-- Messaging and follow-up sections count messages created in the period.
create index if not exists conversation_messages_org_created_idx on conversation_messages (org_id, created_at);

-- Delivery failures reported by providers in the period.
create index if not exists message_delivery_events_org_occurred_idx on message_delivery_events (org_id, occurred_at);

-- ---------------------------------------------------------------------------
-- Calendars and slots
-- ---------------------------------------------------------------------------

-- Native appointments overlapping a window (end after its start), and the upcoming list (end after now).
create index if not exists appointment_refs_native_end_idx on appointment_refs (org_id, end_at) where provider = 'native';

-- A person's held time overlapping a window, for slot computation and every booking's conflict check.
create index if not exists crm_busy_blocks_user_end_idx on crm_busy_blocks (org_id, user_id, ends_at) where released_at is null;
