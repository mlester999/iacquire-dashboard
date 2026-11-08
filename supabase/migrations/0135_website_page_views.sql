-- 0135: count published public-site document loads and retain only bounded daily campaign dimensions.
-- No cookie, visitor ID, IP address, full referrer URL, or person-level event is stored.

alter table website_usage_daily
  add column page_views bigint not null default 0 check (page_views >= 0);

create table website_page_views_daily (
  website_id uuid not null,
  org_id uuid not null,
  day date not null,
  page_slug text not null check (page_slug = '__other__' or page_slug ~ '^[a-z0-9]+([_-][a-z0-9]+)*$'),
  utm_source text not null default '' check (utm_source = '' or (char_length(utm_source) <= 64 and utm_source ~ '^[a-z0-9][a-z0-9._-]*$')),
  utm_medium text not null default '' check (utm_medium = '' or (char_length(utm_medium) <= 64 and utm_medium ~ '^[a-z0-9][a-z0-9._-]*$')),
  utm_campaign text not null default '' check (utm_campaign = '' or (char_length(utm_campaign) <= 96 and utm_campaign ~ '^[a-z0-9][a-z0-9._-]*$')),
  referrer_host text not null default '' check (referrer_host = '' or (char_length(referrer_host) <= 253 and referrer_host ~ '^[a-z0-9.-]+$')),
  page_views bigint not null default 1 check (page_views > 0),
  primary key (website_id, day, page_slug, utm_source, utm_medium, utm_campaign, referrer_host),
  foreign key (website_id, org_id) references websites (id, org_id) on delete cascade
);
create index website_page_views_org_idx on website_page_views_daily (org_id, day desc);

alter table website_page_views_daily enable row level security;
revoke all on website_page_views_daily from public, anon, authenticated, iaq_site_runtime;
grant select on website_page_views_daily to iaq_app_user;
create policy website_page_views_select on website_page_views_daily
  for select to iaq_app_user using (org_id = any ((select app.permitted_orgs('website.view'::text))::uuid[]));

-- The public runtime may call this narrow function only. Its tenant and site identity always come from a verified,
-- currently published host; none of the campaign fields can select or write another tenant.
create or replace function app.record_site_page_view(
  p_host text, p_page_slug text, p_utm_source text, p_utm_medium text, p_utm_campaign text, p_referrer_host text
) returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  s record;
  v_day date := (now() at time zone 'utc')::date;
  v_slug text;
  v_source text;
  v_medium text;
  v_campaign text;
  v_referrer text;
  v_dimensions integer;
begin
  if p_host is null or char_length(p_host) > 253 then return; end if;
  select * into s from app.site_by_host(lower(trim(p_host))) limit 1;
  if not found then return; end if;

  v_slug := lower(trim(coalesce(p_page_slug, '')));
  if char_length(v_slug) > 80 or v_slug !~ '^[a-z0-9]+([_-][a-z0-9]+)*$' or v_slug = 'thanks' then return; end if;

  v_source := lower(trim(coalesce(p_utm_source, '')));
  if char_length(v_source) > 64 or (v_source <> '' and v_source !~ '^[a-z0-9][a-z0-9._-]*$') then v_source := ''; end if;
  v_medium := lower(trim(coalesce(p_utm_medium, '')));
  if char_length(v_medium) > 64 or (v_medium <> '' and v_medium !~ '^[a-z0-9][a-z0-9._-]*$') then v_medium := ''; end if;
  v_campaign := lower(trim(coalesce(p_utm_campaign, '')));
  if char_length(v_campaign) > 96 or (v_campaign <> '' and v_campaign !~ '^[a-z0-9][a-z0-9._-]*$') then v_campaign := ''; end if;
  v_referrer := lower(trim(coalesce(p_referrer_host, '')));
  if char_length(v_referrer) > 253 or (v_referrer <> '' and v_referrer !~ '^[a-z0-9.-]+$') or v_referrer = lower(trim(p_host)) or v_referrer = s.canonical_host then v_referrer := ''; end if;

  -- This upsert serializes dimensions for a site/day and makes their maximum deterministic during a burst.
  insert into website_usage_daily (website_id, org_id, day, page_views)
  values (s.website_id, s.org_id, v_day, 1)
  on conflict (website_id, day) do update set page_views = website_usage_daily.page_views + 1;

  select count(*) into v_dimensions
    from website_page_views_daily
   where website_id = s.website_id and day = v_day;
  if v_dimensions >= 100 then
    v_slug := '__other__';
    v_source := '';
    v_medium := '';
    v_campaign := '';
    v_referrer := '';
  end if;

  insert into website_page_views_daily (website_id, org_id, day, page_slug, utm_source, utm_medium, utm_campaign, referrer_host, page_views)
  values (s.website_id, s.org_id, v_day, v_slug, v_source, v_medium, v_campaign, v_referrer, 1)
  on conflict (website_id, day, page_slug, utm_source, utm_medium, utm_campaign, referrer_host)
  do update set page_views = website_page_views_daily.page_views + 1;
end $$;

revoke all on function app.record_site_page_view(text, text, text, text, text, text) from public;
grant execute on function app.record_site_page_view(text, text, text, text, text, text) to iaq_site_runtime;

comment on table website_page_views_daily is
  'Daily aggregate published-site document loads. Campaign values and referring host only; no visitor identifier or full referrer URL.';
