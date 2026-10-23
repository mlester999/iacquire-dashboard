import "server-only";
import { recordFormTouch } from "@/server/attribution/touches";
import { withSystem, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { notifyOrgRoles, notifyUser } from "@/server/notifications";
import { systemActor, type CrmActor } from "@/server/crm/actor";
import { createContactInTx, findByIdentities } from "@/server/crm/contacts";
import { emitEvent, recordActivity } from "@/server/crm/events";
import { loadFieldDefinitions, writeFieldValues } from "@/server/crm/fields";
import { applyContactTags } from "@/server/crm/tags";
import { createOpportunityInTx } from "@/server/crm/opportunities";
import { assignWithRule } from "@/server/crm/assignment";
import { getConsent, recordConsent } from "@/server/messaging/contacts";
import { saveSurveyFeedback } from "@/server/reputation/survey-feedback";
import { coerceFieldValue } from "@/lib/crm/fields";
import { composeDisplayName } from "@/lib/crm/types";
import { consentChannels, renderDealName, spamReason, type Attribution } from "@/lib/crm/forms/logic";
import { customFieldInput, mapSubmission } from "@/lib/crm/forms/mapping";
import type { Answers } from "@/lib/crm/forms/spec";
import { contactsAreNative, loadFormRow, loadVersionRow, type FormRow, type VersionRow } from "@/server/crm/forms/store";
import type { SubmissionSource } from "@/server/crm/forms/submissions";

// Turning received submissions into CRM records, from the scheduler (src/server/ops/tick.ts). Each run claims a batch with
// FOR UPDATE SKIP LOCKED (so several workers never take the same row), counts an attempt, and processes each submission in its own
// transaction: the contact (matched only by exact email or phone, in the form's own workspace), consent exactly as worded, custom
// fields through the CRM's field rules, tags, a deal (once, by idempotency key), an assignment rule, the form.submitted event for
// workflows and webhooks (deterministic dedupe key), a timeline entry and the team's notifications. Everything it does is keyed to the
// submission, so processing the same submission twice changes nothing.

export const MAX_FORM_ATTEMPTS = 5;
const NOTE_MAX = 500;

export interface FormProcessResult {
  claimed: number;
  processed: number;
  spam: number;
  failed: number;
}

interface SubmissionRow {
  id: string;
  org_id: string;
  form_id: string;
  version_id: string;
  source: SubmissionSource;
  host: string | null;
  page_slug: string | null;
  answers: Answers;
  attribution: Attribution;
  consent_text: string | null;
  marketing_opt_in: boolean;
  marketing_text: string | null;
  status: string;
  spam_cleared: boolean;
  attempts: number;
  created_at: Date;
}

type Outcome = "processed" | "spam" | "failed" | "skipped";

/** Processes up to `limit` received submissions. Safe to run from several workers at once and to run again after a crash. */
export async function processFormSubmissions(opts: { limit?: number; now?: Date } = {}): Promise<FormProcessResult> {
  const claimed = await withSystem(async (db) =>
    (await db.query<{ id: string; org_id: string; attempts: number }>(
      `update crm_form_submissions set attempts = attempts + 1 where id in (
         select id from crm_form_submissions where status = 'received' and attempts < $2 order by created_at, id limit $1 for update skip locked)
       returning id, org_id, attempts`,
      [Math.min(50, Math.max(1, opts.limit ?? 20)), MAX_FORM_ATTEMPTS],
    )).rows,
  );
  const out: FormProcessResult = { claimed: claimed.length, processed: 0, spam: 0, failed: 0 };
  for (const c of claimed) {
    try {
      const r = await withSystem((db) => processSubmissionInTx(db, c.id, c.org_id, opts.now ?? new Date()));
      if (r !== "skipped") out[r] += 1;
    } catch (err) {
      const final = c.attempts >= MAX_FORM_ATTEMPTS;
      const why = err instanceof AppError ? err.message : "Something went wrong while adding this submission.";
      const note = (final ? `Couldn't be processed: ${why}` : `${why} It will be tried again.`).slice(0, NOTE_MAX);
      await withSystem(async (db) => {
        const res = await db.query<{ form_id: string; name: string }>(
          `update crm_form_submissions s set error = $3, status = case when $4 then 'failed' else s.status end
           from crm_forms f where s.id = $1 and s.org_id = $2 and f.id = s.form_id and f.org_id = s.org_id and s.status = 'received' returning s.form_id, f.name`,
          [c.id, c.org_id, note, final],
        );
        if (final && res.rows[0]) {
          await notifyOrgRoles(db, c.org_id, ["owner", "admin"], {
            kind: "system", severity: "warning", title: `A submission to “${res.rows[0].name}” couldn't be added`.slice(0, 200), body: why.slice(0, 300),
            link: `/crm/forms/${res.rows[0].form_id}?tab=submissions&status=failed`, dedupeKey: `crm-form-failed:${c.id}`,
          });
        }
      }).catch(() => undefined);
      if (final) out.failed += 1;
    }
  }
  return out;
}

/** Notifies the members in these roles who may see contacts (a notification names the person who wrote in). */
async function notifyRolesWhoSeeContacts(db: Queryable, orgId: string, roles: string[], n: { title: string; body: string; link: string; dedupeKey: string }) {
  if (!roles.length) return;
  await db.query(
    `insert into notifications (org_id, user_id, kind, severity, title, body, link, dedupe_key)
     select $1, m.user_id, 'system', 'info', $3, $4, $5, $6 from organization_memberships m join users u on u.id = m.user_id
     where m.org_id = $1 and m.status = 'active' and u.status = 'active' and m.role = any($2::text[])
       and (m.role = 'owner' or coalesce(
             (select o.effect = 'grant' from member_permission_overrides o where o.org_id = m.org_id and o.user_id = m.user_id and o.permission = 'contacts.view'),
             exists (select 1 from role_permissions rp where rp.role = m.role and rp.permission = 'contacts.view')))
     on conflict (user_id, dedupe_key) where dedupe_key is not null do nothing`,
    [orgId, roles, n.title.slice(0, 200), n.body.slice(0, 1000), n.link, n.dedupeKey],
  );
}

function whereFrom(s: SubmissionRow, form: FormRow): string {
  if (s.source === "website") return `website ${s.host ?? ""}${s.page_slug && s.page_slug !== "home" ? `/${s.page_slug}` : ""}`.trim();
  if (s.source === "hosted") return `form page /f/…/${form.key}`;
  return s.source;
}

async function markProcessed(db: Queryable, s: SubmissionRow, contactId: string | null, opportunityId: string | null, notes: string[]) {
  await db.query(
    "update crm_form_submissions set status = 'processed', contact_id = $3, opportunity_id = $4, processed_at = now(), error = $5 where id = $1 and org_id = $2",
    [s.id, s.org_id, contactId, opportunityId, notes.length ? notes.join(" ").slice(0, NOTE_MAX) : null],
  );
  // Where this lead came from, as the visit reported it. Recorded once per submission, so a retried run adds nothing.
  if (contactId) await recordFormTouch(db, { orgId: s.org_id, contactId, kind: "crm_form", submissionId: s.id, attribution: { ...s.attribution }, occurredAt: s.created_at });
}

/** Which contacts own the email and phone the person gave (exact, normalized identifiers only; never names). */
async function ownersOf(db: Queryable, orgId: string, email: string | null, phone: string | null): Promise<{ email: string | null; phone: string | null }> {
  const owners = await findByIdentities(db, orgId, email ? [email] : [], phone ? [phone] : []);
  return {
    email: email ? owners.find((o) => o.kind === "email" && o.value === email)?.contactId ?? null : null,
    phone: phone ? owners.find((o) => o.kind === "phone" && o.value === phone)?.contactId ?? null : null,
  };
}

const ADDRESS_WORDS = { email: "email address", phone: "phone number" } as const;

/**
 * One submission, inside the caller's transaction. Re-reads the row under a lock and does nothing unless it is still waiting, so a
 * second worker (or a retry after a crash) can't act twice.
 */
export async function processSubmissionInTx(db: Queryable, id: string, orgId: string, now = new Date()): Promise<Outcome> {
  const { rows } = await db.query<SubmissionRow>(
    `select id, org_id, form_id, version_id, source, host, page_slug, answers, attribution, consent_text, marketing_opt_in, marketing_text, status, spam_cleared, attempts, created_at
     from crm_form_submissions where id = $1 and org_id = $2 for update`,
    [id, orgId],
  );
  const s = rows[0];
  if (!s || s.status !== "received") return "skipped";
  const form = await loadFormRow(db, orgId, s.form_id);
  const version: VersionRow | null = await loadVersionRow(db, orgId, s.version_id);
  if (!form || !version) {
    await db.query("update crm_form_submissions set status = 'failed', error = 'The form this was sent to no longer exists.', processed_at = now() where id = $1 and org_id = $2", [s.id, orgId]);
    return "failed";
  }
  const questions = version.fields;
  const answers = s.answers ?? {};

  // Someone on the team decided this one isn't spam: their decision stands over the automatic check.
  const spam = s.spam_cleared ? null : spamReason(questions, answers);
  if (spam) {
    await db.query("update crm_form_submissions set status = 'spam', error = $3, processed_at = now() where id = $1 and org_id = $2", [s.id, orgId, `Set aside as likely spam: ${spam}`.slice(0, NOTE_MAX)]);
    return "spam";
  }

  const org = (await db.query<{ name: string; timezone: string | null }>("select name, timezone from organizations where id = $1", [orgId])).rows[0];
  const actor: CrmActor = systemActor({ id: orgId, name: org?.name ?? "", timezone: org?.timezone || "UTC" }, `Form: ${form.name}`.slice(0, 80));
  const mapped = mapSubmission(questions, answers, version.actions);
  const notes: string[] = [];
  const email = mapped.contact.email ?? null;
  const phone = mapped.contact.phone ?? null;
  let contactId: string | null = null;
  let opportunityId: string | null = null;
  let createdContact = false;

  if (email || phone) {
    if (!(await contactsAreNative(db, orgId))) {
      await db.query(
        "update crm_form_submissions set status = 'failed', error = $3, processed_at = now() where id = $1 and org_id = $2",
        [s.id, orgId, "Contacts are managed in GoHighLevel for this workspace, so this submission couldn't be added to iAcquire CRM. Its answers are kept here."],
      );
      await notifyOrgRoles(db, orgId, ["owner", "admin"], {
        kind: "system", severity: "warning", title: `A submission to “${form.name}” couldn't be added`.slice(0, 200),
        body: "Contacts are managed in GoHighLevel for this workspace. Open the submission to follow up by hand.", link: `/crm/forms/${form.id}?tab=submissions&status=failed`, dedupeKey: `crm-form-failed:${s.id}`,
      });
      return "failed";
    }
    const callingCode = (await db.query<{ c: string | null }>("select default_calling_code as c from crm_workspaces where org_id = $1", [orgId])).rows[0]?.c ?? null;

    // Custom field values, checked with the CRM's own field rules first: a value a field no longer accepts is left out (and noted)
    // instead of stopping the whole submission.
    const defs = new Map((await loadFieldDefinitions(db, orgId, "contact")).map((d) => [d.key, d]));
    const customValues: Record<string, unknown> = {};
    for (const c of mapped.custom) {
      const def = defs.get(c.fieldKey);
      if (!def) {
        notes.push(`“${c.question.label}” wasn't saved to the contact: its custom field no longer exists.`);
        continue;
      }
      const input = customFieldInput(def, c.question, c.value);
      const check = coerceFieldValue(def, input, { defaultCallingCode: callingCode });
      if (!check.ok) {
        notes.push(`“${c.question.label}” wasn't saved to “${def.label}”: ${check.error}`);
        continue;
      }
      customValues[def.key] = input;
    }

    // Who this is, by the exact email and phone given only. Anyone can fill in a public form, so a submission never changes which addresses
    // an existing contact has: an address that isn't on the matched contact stays on the submission (the team can add it after checking),
    // and an email and phone that belong to two different contacts go to the team instead of being guessed between.
    let owners = await ownersOf(db, orgId, email, phone);
    const matched = [...new Set([owners.email, owners.phone].filter((x): x is string => Boolean(x)))];
    if (matched.length > 1) {
      await db.query(
        "update crm_form_submissions set status = 'failed', error = $3, processed_at = now() where id = $1 and org_id = $2",
        [s.id, orgId, "The email address and the phone number given belong to two different contacts, so it wasn't added to either. Check who sent it and add it to the right contact by hand (or merge the two contacts), then try it again."],
      );
      await notifyOrgRoles(db, orgId, ["owner", "admin"], {
        kind: "system", severity: "warning", title: `A submission to “${form.name}” needs checking`.slice(0, 200),
        body: "Its email address and phone number belong to two different contacts, so it wasn't added to either.", link: `/crm/forms/${form.id}?tab=submissions&status=failed`, dedupeKey: `crm-form-failed:${s.id}`,
      });
      return "failed";
    }

    const created = matched.length
      ? { id: matched[0], created: false }
      : await createContactInTx(
          db, actor,
          {
            firstName: mapped.contact.firstName ?? null, lastName: mapped.contact.lastName ?? null, displayName: mapped.contact.displayName ?? null, email, phone,
            addressLine1: mapped.contact.addressLine1 ?? null, city: mapped.contact.city ?? null, region: mapped.contact.region ?? null, postalCode: mapped.contact.postalCode ?? null,
            source: `Form: ${form.name}`.slice(0, 60), customFields: customValues,
          },
          { via: "form", onDuplicate: "return_existing", tagSource: "form" },
        );
    contactId = created.id;
    createdContact = created.created;
    // Someone else added one of these addresses a moment ago: it is that contact's now.
    if (!created.created && !matched.length) owners = await ownersOf(db, orgId, email, phone);

    if (!created.created) {
      // An existing contact: what the person typed fills in what the contact is missing, never overwrites what the team recorded. Their
      // answers to custom-field questions are their latest, so those are saved. Its addresses are never changed (see above).
      const cur = (await db.query<{ first_name: string | null; last_name: string | null; display_name: string; email: string | null; phone: string | null; address_line1: string | null; city: string | null; region: string | null; postal_code: string | null }>(
        "select first_name, last_name, display_name, email::text as email, phone, address_line1, city, region, postal_code from contacts where id = $1 and org_id = $2 for update",
        [contactId, orgId],
      )).rows[0];
      const sets: string[] = [];
      const params: unknown[] = [contactId, orgId];
      const changed: string[] = [];
      const fill = (column: keyof NonNullable<typeof cur>, value: string | undefined | null, key: string, max: number) => {
        if (!cur || !value || cur[column]) return;
        params.push(value.slice(0, max));
        sets.push(`${column} = $${params.length}`);
        changed.push(key);
      };
      fill("first_name", mapped.contact.firstName, "firstName", 100);
      fill("last_name", mapped.contact.lastName, "lastName", 100);
      fill("address_line1", mapped.contact.addressLine1, "addressLine1", 200);
      fill("city", mapped.contact.city, "city", 100);
      fill("region", mapped.contact.region, "region", 100);
      fill("postal_code", mapped.contact.postalCode, "postalCode", 20);
      if (cur && !cur.display_name.trim()) {
        const name = composeDisplayName(cur.first_name ?? mapped.contact.firstName, cur.last_name ?? mapped.contact.lastName, mapped.contact.displayName);
        if (name) {
          params.push(name);
          sets.push(`display_name = $${params.length}`);
          changed.push("displayName");
        }
      }
      for (const [kind, value] of [["email", email], ["phone", phone]] as const) {
        if (value && owners[kind] !== contactId) {
          notes.push(`The ${ADDRESS_WORDS[kind]} given isn't on this contact, so it wasn't added: a form can't add an address to an existing contact. Check it with the person before adding it by hand.`);
        }
      }
      if (Object.keys(customValues).length) {
        const fieldChanges = await writeFieldValues(db, actor, "contact", contactId, customValues, { defaultCallingCode: callingCode });
        changed.push(...fieldChanges.map((k) => `cf:${k}`));
      }
      if (changed.length) {
        await db.query(`update contacts set ${sets.length ? `${sets.join(", ")}, ` : ""}version = version + 1 where id = $1 and org_id = $2`, params);
        await emitEvent(db, actor, { type: "contact.updated", entityType: "contact", entityId: contactId, contactId, payload: { changed, via: "form" }, dedupeKey: `contact.updated:${contactId}:form:${s.id}` });
      }
    }

    // Consent, exactly as far as the words on the form went: only the channels the wording names, and only for an address this submission
    // gave that is this contact's own (read again here, so an address that belongs to someone else, or wasn't added, never gets consent).
    // The separate marketing box counts only when it was ticked, and only for the channels its own wording names.
    const own = await ownersOf(db, orgId, email, phone);
    const has = { email: Boolean(email) && own.email === contactId, phone: Boolean(phone) && own.phone === contactId };
    const where = whereFrom(s, form);
    const record = async (purpose: "service" | "marketing", wording: string) => {
      for (const channel of consentChannels(wording, has)) {
        const before = await getConsent(db, orgId, contactId!, channel, purpose);
        const evidence = `${purpose === "marketing" ? "Marketing opt-in ticked" : "Consent ticked"} on “${form.name}” (version ${version.version}, ${where}): “${wording}”`.slice(0, 500);
        // The same grant with the same words is already on record (processing again after a crash): nothing new to record.
        const same = await db.query(
          "select 1 from contact_consent_events where org_id = $1 and contact_id = $2 and channel = $3 and purpose = $4 and status = 'granted' and source = 'crm_form' and evidence = $5 order by id desc limit 1",
          [orgId, contactId, channel, purpose, evidence],
        );
        if (before === "granted" && same.rows[0]) continue;
        await recordConsent(db, { orgId, contactId: contactId!, channel, purpose, status: "granted", source: "crm_form", evidence });
        if (before !== "granted") {
          await emitEvent(db, actor, {
            type: "contact.consent_changed", entityType: "contact", entityId: contactId, contactId, payload: { channel, purpose, status: "granted", via: "form", submissionId: s.id },
            dedupeKey: `contact.consent:${contactId}:${channel}:${purpose}:form:${s.id}`,
          });
        }
      }
    };
    if (s.consent_text?.trim()) await record("service", s.consent_text.trim());
    if (s.marketing_opt_in && s.marketing_text?.trim()) await record("marketing", s.marketing_text.trim());

    // Tags that still exist.
    if (version.actions.tagIds?.length) {
      const live = (await db.query<{ id: string }>("select id from crm_tags where org_id = $1 and id = any($2::uuid[])", [orgId, version.actions.tagIds])).rows.map((r) => r.id);
      if (live.length < new Set(version.actions.tagIds).size) notes.push("A tag chosen on the form no longer exists, so it wasn't added.");
      if (live.length) await applyContactTags(db, actor, [contactId], live, "form");
    }

    // A deal, once per submission whatever happens (idempotency key form:<submission id>).
    const o = version.actions.opportunity;
    if (o) {
      const owner = await db.query<{ mode: string; provider: string | null }>(
        "select w.mode, p.provider from crm_workspaces w left join crm_capability_providers p on p.org_id = w.org_id and p.capability = 'opportunities' where w.org_id = $1",
        [orgId],
      );
      const w = owner.rows[0];
      const dealsNative = !w || (w.mode === "hybrid" ? (w.provider ?? "native") : w.mode) === "native";
      const stage = dealsNative
        ? (await db.query<{ kind: string }>(
            `select s.kind from crm_pipeline_stages s join crm_pipelines p on p.id = s.pipeline_id and p.org_id = s.org_id
             where s.id = $1 and s.pipeline_id = $2 and s.org_id = $3 and s.archived_at is null and p.archived_at is null and p.provider = 'native'`,
            [o.stageId, o.pipelineId, orgId],
          )).rows[0]
        : undefined;
      if (!dealsNative) notes.push("Deals are managed in GoHighLevel for this workspace, so no deal was created.");
      else if (!stage || stage.kind !== "open") notes.push("No deal was created: the pipeline or stage chosen on the form no longer exists or is closed.");
      else {
        const c = (await db.query<{ first_name: string | null; last_name: string | null; display_name: string }>("select first_name, last_name, display_name from contacts where id = $1 and org_id = $2", [contactId, orgId])).rows[0];
        const name = renderDealName(o.name, { firstName: c?.first_name, lastName: c?.last_name, fullName: c?.display_name, formName: form.name, answers, questions });
        const opp = await createOpportunityInTx(db, actor, { name, pipelineId: o.pipelineId, stageId: o.stageId, contactId, value: mapped.dealValue, source: `Form: ${form.name}`.slice(0, 120) }, { via: "form", idempotencyKey: `form:${s.id}` });
        opportunityId = opp.id;
      }
    }
  }

  // A survey's answers saved as private feedback: attributed to the contact this submission made or matched, or to nobody when it gave neither (the score and the follow-up of a
  // low one are those of an answer given through a review request's link: src/server/reputation/survey-feedback.ts). Keyed to the submission, so a retry saves nothing twice.
  if (mapped.feedback && form.kind === "survey") {
    const saved = await saveSurveyFeedback(db, actor, { submissionId: s.id, formName: form.name, contactId, feedback: mapped.feedback, receivedAt: new Date(s.created_at), now });
    notes.push(...saved.notes);
  }

  // The event workflows and webhooks start from. Its dedupe key is the submission, so it is recorded exactly once.
  const payloadAnswers = JSON.stringify(answers).length <= 6000 ? answers : undefined;
  const ev = await emitEvent(db, actor, {
    type: "form.submitted", entityType: "form", entityId: form.id, contactId,
    payload: {
      submissionId: s.id, formId: form.id, formKey: form.key, formName: form.name, kind: form.kind, purpose: form.purpose, version: version.version, source: s.source,
      contactId, contactCreated: createdContact, opportunityId, marketingOptIn: s.marketing_opt_in, attribution: s.attribution ?? {},
      ...(payloadAnswers ? { answers: payloadAnswers } : { answersOmitted: true }),
    },
    dedupeKey: `form.submitted:${s.id}`,
  });
  const eventId = ev.id ?? (await db.query<{ id: string }>("select id::text as id from crm_events where org_id = $1 and dedupe_key = $2", [orgId, `form.submitted:${s.id}`])).rows[0]?.id;

  // An assignment rule chosen on the form: a contact rule assigns the contact, a deal rule the deal.
  const ruleId = version.actions.assignmentRuleId;
  if (ruleId && contactId) {
    const rule = (await db.query<{ entity: "contact" | "opportunity" }>("select entity from crm_assignment_rules where id = $1 and org_id = $2", [ruleId, orgId])).rows[0];
    const entityId = rule?.entity === "opportunity" ? opportunityId : contactId;
    if (!rule) notes.push("The assignment rule chosen on the form no longer exists, so nobody was assigned.");
    else if (!entityId) notes.push("The assignment rule assigns deals, and no deal was created.");
    else {
      try {
        const r = await assignWithRule(db, actor, { ruleId, entity: rule.entity, entityId, causedBy: eventId ? { eventId: Number(eventId), depth: 0 } : null, now });
        if (r.status === "skipped") notes.push(`Nobody was assigned: ${r.reason}`);
      } catch (err) {
        if (!(err instanceof AppError)) throw err;
        notes.push(`Nobody was assigned: ${err.message}`);
      }
    }
  }

  const logged = contactId ? await db.query("select 1 from crm_activities where org_id = $1 and ref_type = 'crm_form_submission' and ref_id = $2 limit 1", [orgId, s.id]) : null;
  if (contactId && !logged?.rows[0]) {
    await recordActivity(db, actor, {
      kind: "form.submitted", summary: `Sent the ${form.kind === "survey" ? "survey" : "form"} “${form.name}”`, contactId, opportunityId,
      refType: "crm_form_submission", refId: s.id, metadata: { formId: form.id, formKey: form.key, version: version.version, source: s.source }, occurredAt: new Date(s.created_at),
    });
  }

  // The team hears about it: the roles the form names (only people who may see contacts) and the contact's owner.
  const who = contactId
    ? (await db.query<{ n: string; e: string | null }>("select display_name as n, email::text as e from contacts where id = $1 and org_id = $2", [contactId, orgId])).rows[0]
    : undefined;
  const notice = {
    title: `New ${form.kind === "survey" ? "survey response" : "submission"}: ${form.name}`,
    body: who ? `From ${who.n || who.e || "a new contact"}.` : "Answers were received (no contact details were asked for).",
    link: `/crm/forms/${form.id}?tab=submissions`,
    dedupeKey: `crm-form:${s.id}`,
  };
  await notifyRolesWhoSeeContacts(db, orgId, version.actions.notify?.roles ?? [], notice);
  if (version.actions.notify?.contactOwner && contactId) {
    const owner = (await db.query<{ u: string | null }>("select assigned_user_id as u from contacts where id = $1 and org_id = $2", [contactId, orgId])).rows[0]?.u;
    if (owner) await notifyUser(db, owner, orgId, { kind: "system", severity: "info", ...notice });
  }

  await markProcessed(db, s, contactId, opportunityId, notes);
  return "processed";
}
