-- Rollback for 0081_ai_work_job_rls_hardening.sql. NOT a migration: review and run in one transaction.
-- Return to 0080's row-wise permission checks while retaining the explicit event/job tenant match.

alter policy ai_work_jobs_select on public.ai_work_jobs using (
  org_id = ANY ((SELECT app.permitted_orgs('agents.use'::text))::uuid[])
  and (
    capability <> 'proactive_review'
    or requested_by = app.current_user_id()
    or app.has_permission(org_id, 'activity.view'::text)
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
         or j.requested_by = app.current_user_id()
         or app.has_permission(j.org_id, 'activity.view'::text)
       )
  )
);
