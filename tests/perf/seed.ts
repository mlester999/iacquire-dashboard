// A realistic, fictional CRM dataset for the performance suite. Configuration (tags, custom fields, pipelines, the calendar) goes through the
// real services, so it is exactly what the app would create; the bulk records are inserted with set-based SQL (generate_series) because
// 50,000 service calls would take far longer than the queries being measured. Every name, email and phone number is synthetic
// (example.test domains, +1555 numbers). Nothing here contacts a provider.
import { withSystem, type Queryable } from "@/server/db";
import { createTag } from "@/server/crm/tags";
import { createCustomField } from "@/server/crm/fields";
import { createPipeline, listPipelines } from "@/server/crm/pipelines";
import { createAppointmentType, createCalendar, setHostAvailability } from "@/server/calendars/setup";
import { addDays, weekdayOf, zonedDate } from "@/lib/calendars/slots";
import type { CrmOrg } from "../support/crm";

export interface SeedScale {
  contacts: number;
  companies: number;
  opportunities: number;
  threads: number;
  messages: number;
  appointments: number;
  activities: number;
  tasks: number;
}

/** The workspace being measured. */
export const TARGET: SeedScale = { contacts: 50_000, companies: 2_000, opportunities: 5_000, threads: 3_000, messages: 20_000, appointments: 2_000, activities: 60_000, tasks: 3_000 };
/** Each of the two other workspaces, so every query also has to skip other tenants' rows. */
export const NOISE: SeedScale = { contacts: 10_000, companies: 400, opportunities: 1_000, threads: 600, messages: 4_000, appointments: 400, activities: 12_000, tasks: 600 };

export function scaled(base: SeedScale, factor: number): SeedScale {
  const out = { ...base };
  for (const k of Object.keys(out) as Array<keyof SeedScale>) out[k] = Math.max(1, Math.round(base[k] * factor));
  // The thread count can't exceed the contacts (one thread per contact and channel here).
  out.threads = Math.min(out.threads, out.contacts);
  return out;
}

export const TZ = "Asia/Manila";
const FIRST = ["Maria", "Jose", "Ana", "Juan", "Mark", "Grace", "Paolo", "Liza", "Carlo", "Bea", "Miguel", "Sofia", "Rafael", "Camille", "Luis", "Andrea", "Marco", "Nicole", "Gabriel", "Patricia",
  "James", "Emma", "Oliver", "Ava", "Noah", "Mia", "Liam", "Chloe", "Ethan", "Zoe", "Lucas", "Isla", "Mason", "Ella", "Logan", "Aria", "Henry", "Ruby", "Jack", "Ivy"];
const LAST = ["Santos", "Reyes", "Cruz", "Bautista", "Garcia", "Mendoza", "Torres", "Flores", "Ramos", "Navarro", "Smith", "Johnson", "Brown", "Taylor", "Wilson", "Martin", "Lee", "Walker", "Hall", "Young",
  "King", "Wright", "Scott", "Green", "Baker", "Adams", "Nelson", "Hill", "Campbell", "Mitchell", "Roberts", "Carter", "Phillips", "Evans", "Turner", "Parker", "Collins", "Edwards", "Stewart", "Morris",
  "Murphy", "Cook", "Rogers", "Morgan", "Cooper", "Peterson", "Reed", "Bailey", "Bell", "Kelly"];
const CITIES = ["Austin", "Denver", "Manila", "Cebu", "Toronto", "Leeds", "Perth", "Dublin"];
const COUNTRIES = ["US", "US", "PH", "PH", "CA", "GB", "AU", "IE"];
const SOURCES = ["website", "referral", "facebook", "google", "walk-in", "open house"];
const VIA = ["manual", "import", "website_form", "form", "booking", "api", "inbound_message"];
const STATUSES = ["new", "open", "contacted", "qualified", "unqualified", "customer", "inactive"];
export const TAG_NAMES = [
  // 1-10: common (about 1 in 10 contacts each)
  "Newsletter", "Buyer", "Seller", "Renter", "Investor", "First-time buyer", "Downsizer", "Relocating", "Open house visitor", "Website lead",
  // 11-20: medium (about 1 in 40)
  "Pre-approved", "Cash buyer", "Hot lead", "Warm lead", "Cold lead", "Referral partner", "Past client", "Landlord", "Commercial", "Luxury",
  // 21-30: rare (about 1 in 500)
  "VIP", "Do not call", "Complaint", "Board member", "Press", "Vendor", "Builder", "Attorney", "Lender", "Inspector",
];
export const PROPERTY_TYPES = ["house", "condo", "townhouse", "land", "commercial"];

export interface SeededWorkspace {
  orgId: string;
  scale: SeedScale;
  tags: string[];
  fields: { budget: string; propertyType: string; moveIn: string; preApproved: string; notes: string };
  pipelines: Array<{ id: string; name: string; stages: Array<{ id: string; kind: string }> }>;
  calendarId: string;
  typeId: string;
  busyHostId: string;
  sampleContactIds: string[];
  /** Values that exist in this workspace, for the search scenarios. */
  probe: { email: string; phoneDigits: string; namePrefix: string };
  timings: Record<string, number>;
}

async function timed<T>(timings: Record<string, number>, key: string, fn: () => Promise<T>): Promise<T> {
  const t = performance.now();
  try {
    return await fn();
  } finally {
    timings[key] = (timings[key] ?? 0) + (performance.now() - t);
  }
}

/** Weekday working hours 9 to 5 in Manila for the given people. */
const WEEKDAYS_9_TO_5 = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startMinute: 9 * 60, endMinute: 17 * 60 }));

/**
 * Seeds one workspace. `tag` keeps generated identifiers (emails, provider ids, phone numbers) unique across workspaces, the way real
 * tenants differ.
 */
export async function seedWorkspace(c: CrmOrg, scale: SeedScale, tag: { n: number; label: string }): Promise<SeededWorkspace> {
  const owner = c.actor("owner");
  const timings: Record<string, number> = {};
  const orgId = c.org.id;

  // --- Configuration through the services ---------------------------------------------------------------------------------------------
  const tags = await timed(timings, "config", async () => {
    const ids: string[] = [];
    for (const name of TAG_NAMES) ids.push((await createTag(owner, { name })).id);
    return ids;
  });
  const fields = await timed(timings, "config", async () => ({
    budget: (await createCustomField(owner, { entity: "contact", label: "Budget", type: "number" })).id,
    propertyType: (await createCustomField(owner, { entity: "contact", label: "Property type", type: "select", options: PROPERTY_TYPES.map((v) => ({ value: v, label: v[0].toUpperCase() + v.slice(1) })) })).id,
    moveIn: (await createCustomField(owner, { entity: "contact", label: "Move-in date", type: "date" })).id,
    preApproved: (await createCustomField(owner, { entity: "contact", label: "Pre-approved", type: "boolean" })).id,
    notes: (await createCustomField(owner, { entity: "contact", label: "Buyer notes", type: "text" })).id,
  }));
  const pipelines = await timed(timings, "config", async () => {
    await listPipelines(owner, { ensureDefault: true });
    await createPipeline(owner, { name: "Renovations" });
    await createPipeline(owner, { name: "Partnerships" });
    const list = await listPipelines(owner);
    return list.map((p) => ({ id: p.id, name: p.name, stages: p.stages.map((s) => ({ id: s.id, kind: s.kind })) }));
  });
  const busyHostId = c.people.sales.id;
  const { calendarId, typeId } = await timed(timings, "config", async () => {
    for (const who of ["owner", "sales"] as const) await setHostAvailability(owner, c.people[who].id, { timezone: TZ, rules: WEEKDAYS_9_TO_5 });
    const cal = await createCalendar(owner, { name: "Viewings", public: true, members: [{ userId: busyHostId }], assignment: "single" });
    const type = await createAppointmentType(owner, cal.id, { name: "Property viewing", durationMinutes: 60, minNoticeMinutes: 60, maxDaysAhead: 60, bufferAfterMinutes: 15, dailyLimit: 8 });
    return { calendarId: cal.id, typeId: type.id };
  });

  const domain = `${tag.label}.example.test`;
  const phonePrefix = `1555${tag.n}`; // +1555<n><7 digits>: 12 digits, E.164-shaped, never a real subscriber range
  const users = { owner: c.people.owner.id, manager: c.people.manager.id, sales: c.people.sales.id, setter: c.people.setter.id };

  // --- Bulk records -----------------------------------------------------------------------------------------------------------------
  await timed(timings, "contacts", () =>
    withSystem(async (db) => {
      await db.query(
        `insert into contacts (org_id, display_name, first_name, last_name, email, phone, city, country, source, created_via, lead_status, lead_score, assigned_user_id,
                               created_at, last_activity_at, archived_at, deleted_at)
         select $1, s.fn || ' ' || s.ln, s.fn, s.ln,
                lower(s.fn || '.' || s.ln || '.' || s.g) || '@' || $2,
                '+' || $3 || lpad(s.g::text, 7, '0'),
                ($4::text[])[1 + s.g % 8], ($5::text[])[1 + s.g % 8], ($6::text[])[1 + s.g % 6], ($7::text[])[1 + (s.g / 3) % 7], ($8::text[])[1 + (s.g * 31) % 7],
                case when s.g % 3 = 0 then null else s.g % 101 end,
                case s.g % 5 when 0 then null when 1 then $9::uuid when 2 then $10::uuid when 3 then $11::uuid else $12::uuid end,
                s.created,
                case when s.g % 5 < 3 then least(now(), s.created + ((s.g % 200) * interval '1 day')) end,
                case when s.g % 50 = 0 then now() - interval '3 days' end,
                case when s.g % 200 = 7 then now() - interval '1 day' end
         from (select g, ($13::text[])[1 + g % cardinality($13::text[])] as fn, ($14::text[])[1 + (g / 40) % cardinality($14::text[])] as ln,
                      now() - ((g::bigint * 7919) % (730 * 24 * 60)) * interval '1 minute' as created
               from generate_series(1, $15::int) g) s`,
        [orgId, domain, phonePrefix, CITIES, COUNTRIES, SOURCES, VIA, STATUSES, users.owner, users.sales, users.setter, users.manager, FIRST, LAST, scale.contacts],
      );
      // Every email and phone is also an identity (what createContact does), plus a second email for one contact in ten.
      await db.query(
        `insert into contact_identities (org_id, contact_id, kind, value, verified)
         select org_id, id, 'email', email::text, false from contacts where org_id = $1 and email is not null
         union all select org_id, id, 'phone', phone, false from contacts where org_id = $1 and phone is not null
         union all select org_id, id, 'email', 'alt.' || email::text, false from contacts where org_id = $1 and email is not null and right(phone, 1) = '3'`,
        [orgId],
      );
    }),
  );

  // Number the contacts once (stable order) for every later step.
  const sampleContactIds = await timed(timings, "relations", () =>
    withSystem(async (db) => {
      await db.query("create temp table if not exists perf_c (org_id uuid, id uuid, g int)");
      await db.query("delete from perf_c where org_id = $1", [orgId]);
      await db.query("insert into perf_c select org_id, id, row_number() over (order by created_at, id)::int from contacts where org_id = $1 and deleted_at is null", [orgId]);
      await db.query("create index if not exists perf_c_g on perf_c (org_id, g)");
      await db.query("analyze perf_c");
      await db.query(
        `insert into crm_contact_tags (org_id, contact_id, tag_id, source)
         select $1, c.id, t.tag, 'import' from perf_c c
         cross join lateral (values (($2::uuid[])[1 + c.g % 10]),
                                    (case when c.g % 4 = 0 then ($2::uuid[])[11 + (c.g / 4) % 10] end),
                                    (case when c.g % 50 = 0 then ($2::uuid[])[21 + (c.g / 50) % 10] end)) t(tag)
         where c.org_id = $1 and t.tag is not null on conflict do nothing`,
        [orgId, tags],
      );
      await db.query(
        `insert into crm_field_values (org_id, field_id, entity, entity_id, value_number, value_text, value_date, value_bool)
         select $1, f.field, 'contact', c.id, f.n, f.t, f.d, f.b from perf_c c
         cross join lateral (values
           (case when c.g % 5 < 3 then $2::uuid end, (50000 + (c.g::bigint * 7919) % 950000)::numeric, null::text, null::date, null::boolean),
           (case when c.g % 10 < 7 then $3::uuid end, null, ($7::text[])[1 + c.g % 5], null, null),
           (case when c.g % 5 < 2 then $4::uuid end, null, null, current_date + (c.g % 365), null),
           (case when c.g % 2 = 0 then $5::uuid end, null, null, null, c.g % 4 = 0),
           (case when c.g % 5 = 0 then $6::uuid end, null, 'Wants ' || (c.g % 5 + 1) || ' bedrooms near ' || ($8::text[])[1 + c.g % 8], null, null)) f(field, n, t, d, b)
         where c.org_id = $1 and f.field is not null`,
        [orgId, fields.budget, fields.propertyType, fields.moveIn, fields.preApproved, fields.notes, PROPERTY_TYPES, CITIES],
      );
      await db.query(
        `insert into crm_companies (org_id, name, domain, city, country, industry, owner_user_id, created_via)
         select $1, 'Company ' || g || ' ' || ($3::text[])[1 + g % 6], 'company-' || g || '.' || $2, ($4::text[])[1 + g % 8], ($5::text[])[1 + g % 8],
                ($6::text[])[1 + g % 4], case when g % 2 = 0 then $7::uuid end, 'import'
         from generate_series(1, $8::int) g`,
        [orgId, domain, ["Realty", "Homes", "Builders", "Partners", "Group", "Holdings"], CITIES, COUNTRIES, ["Real estate", "Construction", "Finance", "Legal"], users.owner, scale.companies],
      );
      await db.query(
        `insert into crm_contact_companies (org_id, contact_id, company_id, is_primary)
         select $1, c.id, co.id, true from perf_c c
         join (select id, row_number() over (order by name, id)::int as k from crm_companies where org_id = $1) co on co.k = 1 + c.g % $2::int
         where c.org_id = $1 and c.g % 5 < 2`,
        [orgId, scale.companies],
      );
      const { rows } = await db.query<{ id: string }>("select id from perf_c where org_id = $1 and g in (1, 2, 3, 10, 100) order by g", [orgId]);
      return rows.map((r) => r.id);
    }),
  );

  await timed(timings, "opportunities", () =>
    withSystem(async (db) => {
      const live = Number((await db.query<{ n: string }>("select count(*)::text as n from perf_c where org_id = $1", [orgId])).rows[0].n);
      // 70% in the default pipeline, 20% and 10% in the others. Open 70%, won 20%, lost 10%; closed ones spread over four months.
      const main = pipelines[0];
      const second = pipelines[1] ?? main;
      const third = pipelines[2] ?? main;
      const stageArrays = (p: (typeof pipelines)[number]) => ({
        open: p.stages.filter((s) => s.kind === "open").map((s) => s.id),
        won: p.stages.find((s) => s.kind === "won")?.id ?? null,
        lost: p.stages.find((s) => s.kind === "lost")?.id ?? null,
      });
      const parts = [
        { p: main, n: Math.round(scale.opportunities * 0.7), offset: 0 },
        { p: second, n: Math.round(scale.opportunities * 0.2), offset: Math.round(scale.opportunities * 0.7) },
        { p: third, n: scale.opportunities - Math.round(scale.opportunities * 0.7) - Math.round(scale.opportunities * 0.2), offset: Math.round(scale.opportunities * 0.9) },
      ];
      for (const part of parts) {
        const st = stageArrays(part.p);
        await db.query(
          `insert into crm_opportunities (org_id, provider, name, status, pipeline_ref, stage_ref, monetary_value, currency, contact_id, assigned_user_id, created_via,
                                          stage_entered_at, closed_at, created_at)
           select $1, 'native', 'Deal ' || s.g, s.status,
                  $2::uuid, case s.status when 'won' then $4::uuid when 'lost' then $5::uuid else ($3::uuid[])[1 + s.g % cardinality($3::uuid[])] end,
                  case when s.g % 9 = 0 then null else 1000 + (s.g::bigint * 7919) % 99000 end, 'USD',
                  pc.id, case s.g % 3 when 0 then $8::uuid when 1 then $9::uuid else $10::uuid end, 'manual',
                  s.entered, case when s.status <> 'open' then s.entered end, s.entered - interval '3 days'
           from (select g, case when g % 10 < 7 then 'open' when g % 10 < 9 then 'won' else 'lost' end as status,
                        now() - ((g * 37) % (120 * 24)) * interval '1 hour' as entered
                 from generate_series($6::int + 1, $6::int + $11::int) g) s
           left join perf_c pc on pc.org_id = $1 and pc.g = 1 + (s.g * 17) % $7::int`,
          [orgId, part.p.id, st.open, st.won, st.lost, part.offset, live, users.owner, users.sales, users.manager, part.n],
        );
      }
      // Two history rows per deal: its creation and one move.
      await db.query(
        `insert into crm_opportunity_history (org_id, opportunity_id, from_stage, to_stage, from_status, to_status, seconds_in_previous, actor_kind, changed_at)
         select org_id, id, null, stage_ref, null, 'open', null, 'system', created_at from crm_opportunities where org_id = $1 and provider = 'native'
         union all
         select org_id, id, stage_ref, stage_ref, 'open', status, 86400 * (1 + abs(hashtext(id::text)) % 20), 'user', stage_entered_at from crm_opportunities where org_id = $1 and provider = 'native'`,
        [orgId],
      );
      await db.query(
        `insert into crm_opportunity_tags (org_id, opportunity_id, tag_id)
         select o.org_id, o.id, ($2::uuid[])[1 + abs(hashtext(o.id::text)) % 10] from crm_opportunities o where o.org_id = $1 and o.provider = 'native' and abs(hashtext(o.id::text)) % 3 = 0
         on conflict do nothing`,
        [orgId, tags],
      );
      // GoHighLevel cache rows from before a switch: they must never show up in native screens.
      await db.query(
        `insert into crm_opportunities (org_id, provider, ghl_opportunity_id, name, status, monetary_value) select $1, 'ghl', 'ghl-' || $2 || '-' || g, 'Old GHL deal ' || g, 'open', 500
         from generate_series(1, 100) g`,
        [orgId, tag.label],
      );
      await db.query(
        `with o as (select id, row_number() over (order by id)::int as k from crm_opportunities where org_id = $1 and provider = 'native')
         insert into tasks (org_id, title, status, category, opportunity_id, contact_id, assigned_user_id, due_at, completed_at)
         select $1, 'Follow up ' || s.g, s.status, 'sales', o.id, pc.id,
                case s.g % 2 when 0 then $4::uuid else $5::uuid end, now() + ((s.g % 30) - 10) * interval '1 day', case when s.status = 'done' then now() end
         from (select g, case when g % 10 < 6 then 'open' when g % 10 < 8 then 'in_progress' else 'done' end as status from generate_series(1, $2::int) g) s
         left join o on s.g % 3 < 2 and o.k = 1 + (s.g * 7) % $3::int
         left join perf_c pc on s.g % 3 = 2 and pc.org_id = $1 and pc.g = 1 + (s.g * 11) % 1000`,
        [orgId, scale.tasks, scale.opportunities, users.sales, users.owner],
      );
    }),
  );

  await timed(timings, "messaging", () =>
    withSystem(async (db) => {
      await db.query(
        `insert into conversations (org_id, contact_id, channel, status, owner_kind, owner_user_id, assigned_user_id, priority, unread_count,
                                    last_inbound_at, last_outbound_at, last_message_at, last_message_preview)
         select $1, c.id, ($2::text[])[1 + c.g % 3], case when c.g % 10 < 7 then 'open' when c.g % 10 = 7 then 'snoozed' else 'closed' end,
                case c.g % 3 when 0 then 'ai' when 1 then 'unassigned' else 'human' end,
                case when c.g % 3 = 2 then $3::uuid end, case when c.g % 4 = 0 then $4::uuid end,
                case when c.g % 25 = 0 then 'urgent' when c.g % 10 = 0 then 'high' else 'normal' end, c.g % 4,
                now() - ((c.g * 13) % (90 * 24 * 60)) * interval '1 minute' - interval '5 minutes',
                now() - ((c.g * 13) % (90 * 24 * 60)) * interval '1 minute',
                now() - ((c.g * 13) % (90 * 24 * 60)) * interval '1 minute',
                'Thanks, see you at the viewing ' || c.g
         from perf_c c where c.org_id = $1 and c.g <= $5::int`,
        [orgId, ["sms", "email", "whatsapp"], users.sales, users.setter, scale.threads],
      );
      await db.query(
        `insert into conversation_messages (org_id, conversation_id, direction, author_kind, body, status, blocked_reason, provider, provider_message_id, created_at, sent_at, delivered_at, failed_at)
         select $1, cv.id, s.direction, case when s.direction = 'inbound' then 'contact' else 'ai' end, 'Message ' || s.m,
                s.status, case when s.status = 'blocked' then 'quiet_hours' end,
                case when s.direction = 'outbound' then (case cv.channel when 'sms' then 'twilio' when 'email' then 'resend' else 'meta_whatsapp' end) end,
                case when s.status in ('sent', 'delivered', 'failed') then 'pm-' || $3 || '-' || s.m end,
                s.at, case when s.status in ('sent', 'delivered') then s.at end, case when s.status = 'delivered' then s.at + interval '5 seconds' end,
                case when s.status = 'failed' then s.at + interval '5 seconds' end
         from (select m, case when m % 2 = 0 then 'inbound' else 'outbound' end as direction,
                      case when m % 2 = 0 then 'received' when m % 10 in (1, 3, 5) then 'delivered' when m % 10 = 7 then 'sent' when m % 20 = 9 then 'failed' else 'blocked' end as status,
                      now() - ((m::bigint * 7919) % (90 * 24 * 60)) * interval '1 minute' as at
               from generate_series(1, $2::int) m) s
         join (select id, channel, row_number() over (order by id)::int as k from conversations where org_id = $1) cv on cv.k = 1 + s.m % $4::int`,
        [orgId, scale.messages, tag.label, scale.threads],
      );
      await db.query(
        `insert into message_delivery_events (org_id, message_id, provider, provider_event_id, status, occurred_at)
         select org_id, id, provider, 'ev-' || id, case when status = 'failed' then 'failed' else 'delivered' end, coalesce(delivered_at, failed_at)
         from conversation_messages where org_id = $1 and status in ('delivered', 'failed')`,
        [orgId],
      );
      await db.query(
        `insert into human_escalations (org_id, conversation_id, contact_id, category, urgency, summary, status)
         select org_id, id, contact_id, 'human_requested', case when priority = 'urgent' then 'urgent' else 'normal' end, 'Asked to speak with a person', 'open'
         from conversations where org_id = $1 and status = 'open' and owner_kind <> 'human' order by last_message_at desc limit 60`,
        [orgId],
      );
    }),
  );

  await timed(timings, "appointments", () =>
    withSystem(async (db) => {
      // The busy host's next 30 days: six one-hour viewings on every weekday (9-12 and 13-16 Manila), leaving 12:00 and 16:00 free.
      const starts: Date[] = [];
      const today = zonedDate(Date.now(), TZ);
      for (let d = 1; d <= 30; d++) {
        const day = addDays(today, d);
        if (weekdayOf(day) === 0 || weekdayOf(day) === 6) continue;
        for (const h of ["09", "10", "11", "13", "14", "15"]) starts.push(new Date(`${day}T${h}:00:00+08:00`));
      }
      const future = starts.slice(0, Math.max(0, Math.min(starts.length, scale.appointments)));
      const past = scale.appointments - future.length;
      await insertAppointments(db, { orgId, calendarId, typeId, hostId: busyHostId, starts: future, status: "confirmed" });
      // History: one-hour appointments every five hours going back, alternating between two hosts (never overlapping for one person).
      const pastStarts = Array.from({ length: past }, (_, i) => new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000 - (i + 10) * 5 * 3_600_000));
      await insertAppointments(db, { orgId, calendarId, typeId, hostId: busyHostId, starts: pastStarts.filter((_, i) => i % 2 === 0), status: "showed" });
      await insertAppointments(db, { orgId, calendarId, typeId, hostId: users.owner, starts: pastStarts.filter((_, i) => i % 2 === 1), status: "showed" });
      await db.query(
        `update appointment_refs set status = case abs(hashtext(id::text)) % 10 when 0 then 'noshow' when 1 then 'cancelled' else status end
         where org_id = $1 and provider = 'native' and start_at < now()`,
        [orgId],
      );
      await db.query("update crm_busy_blocks b set released_at = now() from appointment_refs a where a.id = b.appointment_id and a.status = 'cancelled' and b.org_id = $1", [orgId]);
    }),
  );

  await timed(timings, "activities", () =>
    withSystem((db) =>
      db.query(
        `insert into crm_activities (org_id, contact_id, kind, summary, actor_kind, occurred_at)
         select $1, c.id, ($3::text[])[1 + a % 4], 'Recorded ' || a, 'system', now() - ((a::bigint * 7919) % (365 * 24 * 60)) * interval '1 minute'
         from generate_series(1, $2::int) a join perf_c c on c.org_id = $1 and c.g = 1 + (a * 13) % $4::int`,
        [orgId, scale.activities, ["contact.created", "note.added", "message.received", "tag.added"], Math.max(1, scale.contacts - Math.ceil(scale.contacts / 200))],
      ),
    ),
  );

  const probe = await withSystem(async (db) => {
    const { rows } = await db.query<{ email: string; phone: string; first_name: string }>(
      "select email::text as email, phone, first_name from contacts where org_id = $1 and deleted_at is null and archived_at is null order by created_at limit 1 offset $2",
      [orgId, Math.min(4321, Math.floor(scale.contacts / 3))],
    );
    return { email: rows[0].email, phoneDigits: rows[0].phone.replace(/\D/g, "").slice(-8), namePrefix: rows[0].first_name.slice(0, 3).toLowerCase() };
  });

  return { orgId, scale, tags, fields, pipelines, calendarId, typeId, busyHostId, sampleContactIds, probe, timings };
}

async function insertAppointments(db: Queryable, a: { orgId: string; calendarId: string; typeId: string; hostId: string; starts: Date[]; status: string }) {
  if (!a.starts.length) return;
  await db.query(
    `with s as (select t as start_at, row_number() over ()::int as k from unnest($5::timestamptz[]) t),
     ins as (
       insert into appointment_refs (org_id, provider, calendar_ref, appointment_type_id, title, status, start_at, end_at, timezone, assigned_user_id, booked_via, origin, contact_id)
       select $1, 'native', $2, $3, 'Property viewing', $6, s.start_at, s.start_at + interval '1 hour', 'Asia/Manila', $4, 'staff', 'portal_staff', pc.id
       from s left join perf_c pc on pc.org_id = $1 and pc.g = 1 + (s.k * 29) % 5000 returning id, start_at, end_at)
     insert into crm_busy_blocks (org_id, user_id, appointment_type_id, appointment_id, starts_at, ends_at)
     select $1, $4, $3, ins.id, ins.start_at, ins.end_at from ins`,
    [a.orgId, a.calendarId, a.typeId, a.hostId, a.starts, a.status],
  );
  await db.query(
    `insert into crm_appointment_hosts (org_id, appointment_id, user_id) select a.org_id, a.id, $2 from appointment_refs a
     where a.org_id = $1 and a.provider = 'native' and a.assigned_user_id = $2 and not exists (select 1 from crm_appointment_hosts h where h.appointment_id = a.id)`,
    [a.orgId, a.hostId],
  );
  await db.query(
    "update appointment_refs a set busy_block_id = b.id from crm_busy_blocks b where b.appointment_id = a.id and a.org_id = $1 and a.busy_block_id is null",
    [a.orgId],
  );
}

/** Production databases keep planner statistics current (autovacuum); the embedded one needs an explicit ANALYZE after a bulk load. */
export async function analyzeAll() {
  await withSystem((db) => db.query("analyze"));
}

/** Row counts per table for the report, across every workspace and for the target one. */
export async function datasetCounts(orgId: string): Promise<Record<string, number>> {
  return withSystem(async (db) => {
    const out: Record<string, number> = {};
    for (const t of ["contacts", "contact_identities", "crm_contact_tags", "crm_field_values", "crm_companies", "crm_opportunities", "conversations", "conversation_messages", "appointment_refs", "crm_activities", "tasks"]) {
      const { rows } = await db.query<{ all: string; mine: string }>(`select count(*)::text as all, count(*) filter (where org_id = $1)::text as mine from ${t}`, [orgId]);
      out[`${t} (workspace)`] = Number(rows[0].mine);
      out[`${t} (all)`] = Number(rows[0].all);
    }
    return out;
  });
}
