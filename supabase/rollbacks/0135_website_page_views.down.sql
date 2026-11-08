do $$
begin
  if exists (select 1 from website_page_views_daily) or exists (select 1 from website_usage_daily where page_views > 0) then
    raise exception 'Rollback refused: website page-view aggregates exist; export them before rollback';
  end if;
end $$;

revoke all on function app.record_site_page_view(text, text, text, text, text, text) from public, iaq_site_runtime;
drop function app.record_site_page_view(text, text, text, text, text, text);
drop policy website_page_views_select on website_page_views_daily;
drop table website_page_views_daily;
alter table website_usage_daily drop column page_views;
