import "server-only";
import { withSystem, type Queryable } from "@/server/db";
import { assertCan, type CrmActor } from "@/server/crm/actor";
import { typesAwaitingMeetingLink, verifyCalendarInTx } from "@/server/calendars/activation";
import { n8nStepReadiness } from "@/server/integrations/n8n-actions";
import { channelEvidence, type ChannelEvidence, type SetupChannel } from "@/server/setup/native-evidence";
import { requirementDetails } from "@/lib/crm/blueprints/requirements";
import { ENVELOPE_KEYS } from "@/lib/crm/blueprints/package";
import { REQUIREMENT_INFO, REQUIREMENT_KEYS, type AssetSection, type BlueprintContent, type RequirementKey } from "@/lib/crm/blueprints/types";
import type { ChecklistItem, ChecklistStatus, SetupChecklist } from "@/lib/crm/blueprints/views";
import { runtimeReadySql } from "@/lib/employee-runtime";

// The setup checklist after a Blueprint: exactly what this workspace must still connect, map, fill in, rebuild, verify or approve, each
// with the evidence found. The requirements come from the live applications (what their Blueprints need) plus open needs in the data itself
// (draft calendars from a Blueprint or an import, required configuration values left empty). An item is "done" only on evidence in this
// workspace: a verified and activated calendar, an enabled channel whose native provider passed its live capability test recently (the
// Setup Center's own sender evidence), an
// approved template, a verified n8n mapping, a connected voice provider, an included AI employee for "send as", a ready (connected and
// checked) AI employee for AI tasks. Applying a Blueprint never ticks anything, and something iAcquire doesn't offer (taking payments) is
// "unavailable", never pending forever or done.

/** Items a workspace can run without: offered, but not counted against "ready". */
const OPTIONAL: ReadonlySet<RequirementKey> = new Set(["payment_provider", "website_import", "workflow_activation"]);

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const names = (xs: string[], max = 3) => (xs.length <= max ? xs.join(", ") : `${xs.slice(0, max).join(", ")} and ${xs.length - max} more`);

interface Applied {
  blueprintId: string;
  content: BlueprintContent;
  sections: AssetSection[];
  requirements: RequirementKey[];
  slotMappings: Record<string, string>;
}

interface Need {
  assetIds: Set<string>;
  slots: Set<string>;
  /** The workspace records these assets became (via the Blueprint links). */
  natives: Set<string>;
}

/** The checklist for the actor's own workspace. Anyone who can open the CRM sees it (names of records only, never people's details). */
export async function getBlueprintChecklist(actor: CrmActor): Promise<SetupChecklist> {
  assertCan(actor, "crm.view");
  // Trusted read after the check: the evidence spans tables the member's role may not read (connections, AI employees), and only counts and
  // names of configuration records come back.
  return withSystem((db) => getBlueprintChecklistInTx(db, actor.orgId));
}

/** The checklist for one workspace. Trusted: the caller has authorized whoever reads it (agency pages, onboarding). */
export async function getBlueprintChecklistForOrg(orgId: string): Promise<SetupChecklist> {
  return withSystem((db) => getBlueprintChecklistInTx(db, orgId));
}

/** The checklist, read inside the caller's transaction. */
export async function getBlueprintChecklistInTx(db: Queryable, orgId: string, now: Date = new Date()): Promise<SetupChecklist> {
  const applied = await liveApplications(db, orgId);
  const needs = new Map<RequirementKey, Need>();
  const need = (k: RequirementKey) => {
    let n = needs.get(k);
    if (!n) needs.set(k, (n = { assetIds: new Set(), slots: new Set(), natives: new Set() }));
    return n;
  };
  const links = new Map<string, string>();
  for (const l of (await db.query<{ blueprint_id: string; asset_id: string; native_id: string }>("select blueprint_id, asset_id, native_id from crm_blueprint_links where org_id = $1", [orgId])).rows) {
    links.set(`${l.blueprint_id}|${l.asset_id}`, l.native_id);
  }
  const placeholders = new Set<string>();
  // For each role (slot), what every live Blueprint that uses it mapped it to (null: left unmapped). Two Blueprints can declare the same
  // role ID and map it differently; the role counts as mapped only when each of them mapped it to someone active here.
  const slotMapped = new Map<string, Array<string | null>>();
  const slotLabels = new Map<string, string>();
  for (const a of applied) {
    const details = requirementDetails(a.content, a.sections.length ? a.sections : undefined);
    const keys = new Set<RequirementKey>([...a.requirements, ...details.map((d) => d.key)]);
    for (const k of keys) need(k);
    for (const d of details) {
      const n = need(d.key);
      for (const id of d.assetIds) {
        n.assetIds.add(id);
        const native = links.get(`${a.blueprintId}|${id}`);
        if (native) n.natives.add(native);
      }
      for (const s of d.slots) {
        n.slots.add(s);
        if (d.key === "member_mapping") slotMapped.set(s, [...(slotMapped.get(s) ?? []), a.slotMappings[s] ?? null]);
      }
    }
    for (const x of [...a.content.assets.forms, ...a.content.assets.messageTemplates, ...a.content.assets.workflows]) {
      const native = links.get(`${a.blueprintId}|${x.id}`);
      if (x.placeholder && native) placeholders.add(native);
    }
    for (const s of a.content.slots) slotLabels.set(s.id, s.label);
  }

  // Open needs in the data itself, with or without a live application.
  const draftCalendars = (await db.query<{ id: string }>("select id from crm_calendars where org_id = $1 and status = 'draft' and archived_at is null and origin <> 'manual'", [orgId])).rows;
  if (draftCalendars.length) for (const k of ["calendar_hosts", "calendar_verification"] as const) for (const c of draftCalendars) need(k).natives.add(c.id);
  const emptyRequired = await db.query<{ id: string }>("select id from crm_custom_values where org_id = $1 and required and btrim(value) = ''", [orgId]);
  for (const v of emptyRequired.rows) need("custom_values").natives.add(v.id);

  const items: ChecklistItem[] = [];
  for (const key of REQUIREMENT_KEYS) {
    const n = needs.get(key);
    if (!n) continue;
    const evidence = await evidenceFor(db, orgId, key, n, { placeholders, slotMapped, slotLabels, now });
    if (!evidence) continue;
    const info = REQUIREMENT_INFO[key];
    items.push({
      key, label: info.label, description: info.description, status: evidence.status, detail: evidence.detail, path: info.path,
      required: !OPTIONAL.has(key) && evidence.status !== "unavailable", assetIds: [...n.assetIds].sort(), slots: [...n.slots].sort(),
    });
  }
  const counted = items.filter((i) => i.status !== "unavailable");
  return { items, done: counted.filter((i) => i.status === "done").length, total: counted.length };
}

/**
 * What each Blueprint live in the workspace still asks of it, across all of its live applications: an update applied to some sections only
 * doesn't take away what the earlier applications left to do (unpublished forms, unmapped roles, draft workflows). Per Blueprint: the
 * newest application's content and role mappings (mappings carry over from one application to the next), every application's
 * requirements, and the sections they covered together (every section when any of them applied all).
 */
async function liveApplications(db: Queryable, orgId: string): Promise<Applied[]> {
  const { rows } = await db.query<{ blueprint_id: string; sections: string[]; requirements: string[]; summary: { slotMappings?: Record<string, string> } | null; package: Record<string, unknown> }>(
    `select a.blueprint_id, a.sections, a.requirements, a.summary, v.package
     from crm_blueprint_applications a join crm_blueprint_versions v on v.id = a.version_id
     where a.org_id = $1 and a.status in ('applied', 'partially_applied') order by a.blueprint_id, a.created_at desc, a.id desc`,
    [orgId],
  );
  const byBlueprint = new Map<string, Applied>();
  for (const r of rows) {
    const content: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(r.package ?? {})) if (!(ENVELOPE_KEYS as readonly string[]).includes(k)) content[k] = v;
    if (!content.assets || typeof content.assets !== "object") continue;
    const sections = (r.sections ?? []) as AssetSection[];
    const requirements = (r.requirements ?? []).filter((k): k is RequirementKey => (REQUIREMENT_KEYS as readonly string[]).includes(k));
    const seen = byBlueprint.get(r.blueprint_id);
    if (!seen) {
      // The newest live application (rows come newest first).
      byBlueprint.set(r.blueprint_id, { blueprintId: r.blueprint_id, content: content as unknown as BlueprintContent, sections, requirements, slotMappings: r.summary?.slotMappings ?? {} });
      continue;
    }
    seen.requirements = [...new Set([...seen.requirements, ...requirements])];
    // An empty list means every section.
    seen.sections = !seen.sections.length || !sections.length ? [] : [...new Set([...seen.sections, ...sections])];
  }
  return [...byBlueprint.values()];
}

interface EvidenceContext {
  placeholders: Set<string>;
  slotMapped: Map<string, Array<string | null>>;
  slotLabels: Map<string, string>;
  now: Date;
  /** The senders' evidence, read once for the three channel items. */
  channels?: Promise<Record<SetupChannel, ChannelEvidence>>;
}

type Evidence = { status: ChecklistStatus; detail: string } | null;

const done = (detail: string): Evidence => ({ status: "done", detail });
const pending = (detail: string): Evidence => ({ status: "pending", detail });

async function evidenceFor(db: Queryable, orgId: string, key: RequirementKey, n: Need, x: EvidenceContext): Promise<Evidence> {
  const ids = [...n.natives];
  const q = async <T>(sql: string, params: unknown[] = [orgId, ids]) => (await db.query<T>(sql, params)).rows;
  switch (key) {
    case "calendar_hosts":
    case "calendar_verification": {
      const cals = await calendarsOf(db, orgId, n);
      if (!cals.length) return null;
      if (key === "calendar_hosts") {
        const without = cals.filter((c) => c.hosts === 0);
        return without.length ? pending(`${cals.length - without.length} of ${plural(cals.length, "calendar")} ${cals.length - without.length === 1 ? "has" : "have"} hosts. Still to assign: ${names(without.map((c) => c.name))}.`)
          : done(`Every calendar has hosts (${plural(cals.length, "calendar")}).`);
      }
      const drafts = cals.filter((c) => c.status !== "active");
      if (!drafts.length) return done(`Every calendar was verified and activated (${plural(cals.length, "calendar")}).`);
      const notes: string[] = [];
      for (const c of drafts.slice(0, 5)) {
        const v = await verifyCalendarInTx(db, orgId, c.id, x.now);
        const failing = v.checks.filter((k) => !k.ok).map((k) => k.label.toLowerCase());
        notes.push(failing.length ? `“${c.name}” still needs: ${failing.join(", ")}` : `“${c.name}” passes every check and can be activated`);
      }
      return pending(`${plural(drafts.length, "calendar is", "calendars are")} still drafts and take no bookings. ${notes.join(". ")}.`);
    }
    case "google_calendar":
    case "microsoft_calendar": {
      const provider = key === "google_calendar" ? "google" : "microsoft";
      const meeting = key === "google_calendar" ? "google_meet" : "microsoft_teams";
      const types = await q<{ id: string; name: string; calendar_id: string }>(
        `select t.id, t.name, t.calendar_id from crm_appointment_types t where t.org_id = $1 and t.archived_at is null and t.meeting_provider = $3
         and (t.id = any($2::uuid[]) or t.calendar_id in (select id from crm_calendars where org_id = $1 and status = 'draft' and origin <> 'manual' and archived_at is null))`,
        [orgId, ids, meeting],
      );
      if (!types.length) return null;
      const hosts = await q<{ calendar_id: string; user_id: string; name: string; connected: boolean }>(
        `select cm.calendar_id, cm.user_id, coalesce(nullif(u.full_name, ''), u.email::text) as name,
                exists (select 1 from crm_calendar_connections c where c.org_id = cm.org_id and c.user_id = cm.user_id and c.provider = $3 and c.status = 'connected'
                        and c.write_events and c.external_calendar_id is not null) as connected
         from crm_calendar_members cm join organization_memberships m on m.org_id = cm.org_id and m.user_id = cm.user_id and m.status = 'active'
         join users u on u.id = cm.user_id and u.status = 'active'
         where cm.org_id = $1 and cm.active and cm.calendar_id = any($2::uuid[])`,
        [orgId, [...new Set(types.map((t) => t.calendar_id))], provider],
      );
      const label = provider === "google" ? "Google Calendar" : "Microsoft 365";
      if (!hosts.length) return pending(`${names(types.map((t) => t.name))} ${types.length === 1 ? "needs" : "need"} hosts first; each host then connects their own ${label}.`);
      const missing = [...new Set(hosts.filter((h) => !h.connected).map((h) => h.name))];
      return missing.length ? pending(`${names(missing)} ${missing.length === 1 ? "hasn't" : "haven't"} connected ${label} with adding events turned on.`)
        : done(`Every host of these calendars has a connected ${label} that can add events.`);
    }
    case "meeting_link": {
      const types = await q<{ id: string; name: string }>("select id, name from crm_appointment_types where org_id = $1 and id = any($2::uuid[]) and archived_at is null");
      if (!types.length) return null;
      // The same rule calendar activation uses, so the checklist and activation never disagree.
      const missing = await typesAwaitingMeetingLink(db, orgId, { typeIds: types.map((t) => t.id) });
      return missing.length ? pending(`${names(missing.map((t) => t.name))} ${missing.length === 1 ? "has" : "have"} no meeting link yet.`) : done("Every appointment type that needs a meeting link has one.");
    }
    case "email_provider":
    case "sms_provider":
    case "whatsapp_provider": {
      const channel: SetupChannel = key === "email_provider" ? "email" : key === "sms_provider" ? "sms" : "whatsapp";
      const what = channel === "email" ? "Email" : channel === "sms" ? "SMS" : "WhatsApp";
      // The Setup Center's evidence for senders, so this checklist and the client's setup guide apply one rule: done only with a native
      // provider whose live capability test passed recently (src/server/setup/native-evidence.ts) and sending switched on. A GoHighLevel
      // channel, or a pass that is too old, is not done here either.
      const e = (await (x.channels ??= channelEvidence(db, orgId, x.now)))[channel];
      if (e.status === "verified" && e.enabled) return done(`${what} sending is connected and passed its live test.`);
      if (e.status === "verified") return pending(`${what} passed its live test, but sending on this channel is switched off.`);
      return pending(e.summary);
    }
    case "whatsapp_template_approval": {
      const rows = await q<{ name: string; approved: boolean }>(
        `select t.name, exists (select 1 from whatsapp_templates w where w.org_id = t.org_id and w.template_id = t.whatsapp_template_id and w.status = 'approved') as approved
         from crm_message_templates t where t.org_id = $1 and t.id = any($2::uuid[]) and t.archived_at is null and t.channel = 'whatsapp' and t.kind = 'template'`,
      );
      if (!rows.length) return null;
      const waiting = rows.filter((r) => !r.approved);
      return waiting.length ? pending(`${rows.length - waiting.length} of ${plural(rows.length, "WhatsApp template")} linked to a template Meta approved. Still waiting: ${names(waiting.map((r) => r.name))}.`)
        : done("Every WhatsApp template is linked to a template Meta approved.");
    }
    case "template_approval": {
      const rows = await q<{ id: string; name: string; status: string }>("select id, name, status from crm_message_templates where org_id = $1 and id = any($2::uuid[]) and archived_at is null and kind = 'template'");
      const real = rows.filter((r) => !x.placeholders.has(r.id));
      if (!real.length) return null;
      const drafts = real.filter((r) => r.status !== "approved");
      return drafts.length ? pending(`${real.length - drafts.length} of ${plural(real.length, "template")} approved. Drafts: ${names(drafts.map((r) => r.name))}.`) : done("Every template's wording was approved in this workspace.");
    }
    case "member_mapping": {
      if (!n.slots.size) return null;
      const people = new Set((await q<{ user_id: string }>(
        `select m.user_id from organization_memberships m join users u on u.id = m.user_id where m.org_id = $1 and m.status = 'active' and u.status = 'active'`,
        [orgId],
      )).map((r) => r.user_id));
      const slots = [...n.slots].filter((s) => s.startsWith("member."));
      if (!slots.length) return null;
      const open = slots.filter((s) => {
        const targets = x.slotMapped.get(s) ?? [null];
        return !targets.length || targets.some((t) => !t || !people.has(t));
      });
      const labels = open.map((s) => x.slotLabels.get(s) ?? s);
      return open.length
        ? pending(`${slots.length - open.length} of ${plural(slots.length, "role")} mapped to someone in this workspace. Still to choose: ${names(labels)}. Settings that name ${open.length === 1 ? "it" : "them"} were left for you to fill in.`)
        : done(`Every role was mapped to an active person here (${plural(slots.length, "role")}).`);
    }
    case "assignment_members": {
      const rules = await q<{ name: string; active: boolean; strategy: string; members: number }>(
        "select r.name, r.active, r.strategy, (select count(*)::int from crm_assignment_members m where m.rule_id = r.id and m.org_id = r.org_id and not m.paused) as members from crm_assignment_rules r where r.org_id = $1 and r.id = any($2::uuid[])",
      );
      if (!rules.length) return null;
      const off = rules.filter((r) => !r.active || (r.strategy !== "keep_existing_owner" && Number(r.members) === 0));
      return off.length ? pending(`${names(off.map((r) => r.name))} ${off.length === 1 ? "is" : "are"} switched off or ${off.length === 1 ? "has" : "have"} nobody to assign to yet.`)
        : done(`Every assignment rule is on and has people (${plural(rules.length, "rule")}).`);
    }
    case "n8n_mapping":
    case "webhook_endpoints":
    case "ai_employee":
    case "hermes": {
      const flows = await q<{ id: string; name: string; draft: { steps?: Array<{ kind: string; config?: Record<string, unknown> }>; trigger?: unknown } }>(
        "select id, name, draft from crm_workflows where org_id = $1 and id = any($2::uuid[]) and archived_at is null",
      );
      const steps = flows.flatMap((f) => (Array.isArray(f.draft?.steps) ? f.draft.steps : []).map((s) => ({ flow: f.name, kind: s.kind, config: s.config ?? {} })));
      if (key === "n8n_mapping") {
        const uses = steps.filter((s) => s.kind === "n8n");
        if (!uses.length && !n.slots.size) return null;
        const readiness = await n8nStepReadiness(db, orgId);
        const bad = uses.filter((s) => typeof s.config.mappingId !== "string" || !readiness.has(s.config.mappingId as string) || readiness.get(s.config.mappingId as string));
        if (!uses.length) return pending("A role for an n8n automation wasn't mapped, so the workflow step that hands off to n8n is incomplete.");
        return bad.length ? pending(`${names([...new Set(bad.map((s) => s.flow))])} ${bad.length === 1 ? "has an n8n step" : "have n8n steps"} without a verified, ready n8n automation.`)
          : done("Every n8n step points at an n8n automation the agency verified for this client.");
      }
      if (key === "webhook_endpoints") {
        const uses = steps.filter((s) => s.kind === "webhook");
        if (!uses.length && !n.slots.size) return null;
        const active = new Set((await q<{ id: string }>("select id from crm_webhook_subscriptions where org_id = $1 and active", [orgId])).map((r) => r.id));
        const bad = uses.filter((s) => typeof s.config.subscriptionId !== "string" || !active.has(s.config.subscriptionId as string));
        if (!uses.length) return pending("A role for a webhook endpoint wasn't mapped, so the workflow step that sends data out is incomplete.");
        return bad.length ? pending(`${names([...new Set(bad.map((s) => s.flow))])} ${bad.length === 1 ? "sends" : "send"} to a webhook endpoint that isn't set up here yet.`)
          : done("Every webhook step sends to an active endpoint of this workspace.");
      }
      // Senders ("send as") only need the employee included in this workspace; AI tasks need it connected to its AI service and checked.
      const roleOf = (s: (typeof steps)[number]) => (key === "ai_employee" ? (s.kind === "send_message" ? s.config.sendAs : null) : s.kind === "ai_task" ? s.config.roleKey : null);
      const roles = [...new Set(steps.map(roleOf).filter((r): r is string => typeof r === "string" && r.length > 0))];
      if (!roles.length) return null;
      const agents = await q<{ role_key: string; display_name: string; enabled: boolean; paused: boolean; ready: boolean }>(
        `select role_key, display_name, enabled, mode = 'paused' as paused,
                (${runtimeReadySql("agent_instances")} and hermes_base_url is not null) as ready
         from agent_instances where org_id = $1 and role_key = any($2::text[])`,
        [orgId, roles],
      );
      const nameOf = (r: string) => agents.find((a) => a.role_key === r)?.display_name ?? r.replace(/_/g, " ");
      if (key === "ai_employee") {
        const missing = roles.filter((r) => !agents.some((a) => a.role_key === r && a.enabled)).map(nameOf);
        if (missing.length) return pending(`${names(missing)} ${missing.length === 1 ? "isn't" : "aren't"} included in this workspace, so messages sent as ${missing.length === 1 ? "it" : "them"} can't go out. Include ${missing.length === 1 ? "it" : "them"} for this client.`);
        const paused = agents.filter((a) => a.enabled && a.paused).map((a) => a.display_name);
        return done(`Every AI employee these workflows send as is included in this workspace (${plural(roles.length, "employee")}).${paused.length ? ` ${names(paused)} ${paused.length === 1 ? "is" : "are"} paused right now, so ${paused.length === 1 ? "its" : "their"} messages wait until resumed.` : ""}`);
      }
      const notReady = roles.filter((r) => !agents.some((a) => a.role_key === r && a.ready)).map(nameOf);
      return notReady.length ? pending(`${names(notReady)} ${notReady.length === 1 ? "isn't" : "aren't"} connected to ${notReady.length === 1 ? "its" : "their"} AI service and verified for this client yet.`) : done("Every AI employee these workflows ask to do a task passed its connection check.");
    }
    case "voice_provider": {
      const rows = await q<{ provider: string }>("select provider from crm_voice_connections where org_id = $1 and status = 'connected'", [orgId]);
      return rows.length ? done(`A voice provider is connected (${rows.map((r) => (r.provider === "vapi" ? "Vapi" : "Retell")).join(", ")}).`) : pending("No voice provider is connected, so call events can't start these workflows.");
    }
    case "review_links": {
      const rows = await q<{ n: number }>("select count(*)::int as n from crm_review_destinations where org_id = $1 and active", [orgId]);
      const k = Number(rows[0]?.n ?? 0);
      return k ? done(`${plural(k, "review page")} ${k === 1 ? "is" : "are"} set up.`) : pending("No public review page is set up yet, so review requests have nowhere to send people.");
    }
    case "payment_provider":
      return { status: "unavailable", detail: "iAcquire doesn't take payments on a client's behalf. Payments stay in the client's own payment provider, outside the CRM." };
    case "custom_values": {
      const rows = await q<{ label: string; value: string; required: boolean }>("select label, value, required from crm_custom_values where org_id = $1 and (id = any($2::uuid[]) or required)");
      const needed = rows.filter((r) => r.required);
      if (!needed.length) return null;
      const empty = needed.filter((r) => !r.value.trim());
      return empty.length ? pending(`${plural(empty.length, "required value is", "required values are")} empty: ${names(empty.map((r) => r.label))}. Messages that use ${empty.length === 1 ? "it" : "them"} are held until filled in.`)
        : done(`Every required configuration value is filled in (${plural(needed.length, "value")}).`);
    }
    case "form_rebuild": {
      const rows = await q<{ id: string; name: string; questions: number }>("select id, name, coalesce(jsonb_array_length(draft->'questions'), 0) as questions from crm_forms where org_id = $1 and id = any($2::uuid[]) and archived_at is null");
      const ph = rows.filter((r) => x.placeholders.has(r.id));
      if (!ph.length) return null;
      const empty = ph.filter((r) => Number(r.questions) === 0);
      return empty.length ? pending(`${names(empty.map((r) => r.name))} still ${empty.length === 1 ? "has" : "have"} no questions.`) : done("Every placeholder form has questions now.");
    }
    case "template_rebuild": {
      const rows = await q<{ id: string; name: string; body: string }>(
        "select t.id, t.name, v.body from crm_message_templates t join crm_message_template_versions v on v.template_id = t.id and v.org_id = t.org_id and v.version = t.current_version where t.org_id = $1 and t.id = any($2::uuid[]) and t.archived_at is null",
      );
      const ph = rows.filter((r) => x.placeholders.has(r.id));
      if (!ph.length) return null;
      const empty = ph.filter((r) => !r.body.trim());
      return empty.length ? pending(`${names(empty.map((r) => r.name))} still ${empty.length === 1 ? "has" : "have"} no wording.`) : done("Every placeholder template has wording now.");
    }
    case "workflow_rebuild": {
      const rows = await q<{ id: string; name: string; steps: number }>("select id, name, coalesce(jsonb_array_length(draft->'steps'), 0) as steps from crm_workflows where org_id = $1 and id = any($2::uuid[]) and archived_at is null");
      const ph = rows.filter((r) => x.placeholders.has(r.id));
      if (!ph.length) return null;
      const empty = ph.filter((r) => Number(r.steps) === 0);
      return empty.length ? pending(`${names(empty.map((r) => r.name))} still ${empty.length === 1 ? "has" : "have"} no steps.`) : done("Every placeholder workflow has steps now.");
    }
    case "form_publishing": {
      const rows = await q<{ id: string; name: string; status: string }>("select id, name, status from crm_forms where org_id = $1 and id = any($2::uuid[]) and archived_at is null");
      const real = rows.filter((r) => !x.placeholders.has(r.id));
      if (!real.length) return null;
      const drafts = real.filter((r) => r.status !== "published");
      return drafts.length ? pending(`${real.length - drafts.length} of ${plural(real.length, "form")} published. Not taking submissions yet: ${names(drafts.map((r) => r.name))}.`) : done("Every form is published.");
    }
    case "workflow_activation": {
      const rows = await q<{ name: string; status: string }>("select name, status from crm_workflows where org_id = $1 and id = any($2::uuid[]) and archived_at is null");
      if (!rows.length) return null;
      const active = rows.filter((r) => r.status === "active");
      return active.length === rows.length ? done(`Every workflow was approved and activated (${plural(rows.length, "workflow")}).`)
        : pending(`${active.length} of ${plural(rows.length, "workflow")} active. The others stay drafts and never run until the owner reviews, approves and activates them.`);
    }
    case "website_import": {
      const rows = await q<{ n: number }>("select count(*)::int as n from websites w where w.org_id = $1 and w.published_publication_id is not null", [orgId]);
      return Number(rows[0]?.n ?? 0) ? done("A website is live in Website Studio.") : pending("Website pages are candidates for Website Studio. Nothing was published automatically.");
    }
  }
  return null;
}

/** The calendars a calendar requirement is about: the ones a Blueprint created here, plus draft calendars from a Blueprint or an import. */
async function calendarsOf(db: Queryable, orgId: string, n: Need) {
  const { rows } = await db.query<{ id: string; name: string; status: string; hosts: number }>(
    `select c.id, c.name, c.status,
            (select count(*)::int from crm_calendar_members cm join organization_memberships m on m.org_id = cm.org_id and m.user_id = cm.user_id and m.status = 'active'
             join users u on u.id = cm.user_id and u.status = 'active' where cm.calendar_id = c.id and cm.org_id = c.org_id and cm.active) as hosts
     from crm_calendars c where c.org_id = $1 and c.archived_at is null
       and (c.id = any($2::uuid[]) or c.id in (select calendar_id from crm_appointment_types where org_id = $1 and id = any($2::uuid[])))
     order by lower(c.name)`,
    [orgId, [...n.natives]],
  );
  return rows.map((r) => ({ ...r, hosts: Number(r.hosts) }));
}
