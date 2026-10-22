-- Keep workforce job visibility tenant-scoped while evaluating permissions once per statement.
-- These policies were added after 0060_rls_initplan.sql and must use its statement-level helpers.

alter policy ai_work_jobs_select on public.ai_work_jobs using (
  org_id = ANY ((SELECT app.permitted_orgs('agents.use'::text))::uuid[])
  and (
    capability <> 'proactive_review'
    or requested_by = (SELECT app.current_user_id())
    or org_id = ANY ((SELECT app.permitted_orgs('activity.view'::text))::uuid[])
  )
);

alter policy ai_work_events_select on public.ai_work_events using (
  org_id = ANY ((SELECT app.permitted_orgs('agents.use'::text))::uuid[])
  and exists (
    select 1
      from public.ai_work_jobs j
     where j.id = ai_work_events.job_id
       and j.org_id = ai_work_events.org_id
       and (
         j.capability <> 'proactive_review'
         or j.requested_by = (SELECT app.current_user_id())
         or j.org_id = ANY ((SELECT app.permitted_orgs('activity.view'::text))::uuid[])
       )
  )
);
