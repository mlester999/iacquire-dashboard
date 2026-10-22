/**
 * Fictional missed-call recovery and lead-priority data for isolated local browser QA, added on top of the Unified Inbox QA workspace
 * ("Harbor Home Services (Inbox QA)"). It writes through the application's own services into the embedded QA database and sends nothing
 * anywhere: no provider is configured, every send switch is off. Every name, email (example.test) and phone number (555-01xx) is made up.
 *
 *   node scripts/run-inbox-qa-seed.mjs      (first, once)
 *   node scripts/run-phase2-qa-seed.mjs     (this; with the QA server stopped)
 *
 * Idempotent: when the workspace already has a missed-call policy it adds nothing.
 */
import { it } from "vitest";
import { closeDb, withSystem } from "../src/server/db/index";
import { env } from "../src/server/env";
import { memberActor } from "../src/server/crm/actor";
import { recordVoiceEvent } from "../src/server/crm/calls";
import { createContact } from "../src/server/crm/contacts";
import { ingestInbound } from "../src/server/messaging/ingest";
import { dispatchMessage } from "../src/server/messaging/send";
import { processMissedCalls } from "../src/server/missed-calls/engine";
import { activatePolicy, savePolicy } from "../src/server/missed-calls/policy";
import { assessContact } from "../src/server/lead-scoring/service";
import { setOverride } from "../src/server/lead-scoring/priority";
import { permissionsFor, roleHasPermission, type OrgRole } from "../src/lib/permissions";
import type { VoiceCallEvent } from "../src/server/integrations/voice/types";
import type { Membership, OrgContext } from "../src/server/tenancy/context";

const ORG_NAME = "Harbor Home Services (Inbox QA)";
const qaDataDir = () => (process.env.PGLITE_DATA_DIR ?? "").replace(/\\/g, "/");

function assertIsolated() {
  const e = env();
  if (e.NODE_ENV === "production" || e.AUTH_PROVIDER !== "local" || e.DATABASE_DRIVER !== "pglite" || (e.DATABASE_URL ?? "") !== "" || !qaDataDir().startsWith(".data/crm-qa/")) {
    throw new Error("Refusing to seed outside the isolated QA database (local sign-in, embedded pglite in .data/crm-qa). Use node scripts/run-phase2-qa-seed.mjs.");
  }
}
const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await withSystem((db) => db.query<T & Record<string, unknown>>(sql, params))).rows;

function ctxFor(user: { id: string; email: string; full_name: string }, org: { id: string; name: string; slug: string }, role: OrgRole): OrgContext {
  const membership: Membership = { orgId: org.id, name: org.name, slug: org.slug, kind: "client", status: "active", role, isDemo: false, onboardingCompletedAt: null, timezone: "America/Chicago" };
  return {
    user: { sessionId: "qa", id: user.id, email: user.email, fullName: user.full_name, platformRole: "none", timezone: "America/Chicago", preferences: {}, emailVerified: true },
    org: membership, role, permissions: permissionsFor(role), can: (perm) => roleHasPermission(role, perm), memberships: [membership],
  };
}

async function seed() {
  assertIsolated();
  const org = (await q<{ id: string; name: string; slug: string }>("select id, name, slug from organizations where name = $1", [ORG_NAME]))[0];
  if (!org) throw new Error("Run node scripts/run-inbox-qa-seed.mjs first: the Inbox QA workspace does not exist.");
  if ((await q("select 1 from missed_call_policies where org_id = $1", [org.id])).length) {
    console.log("The Phase 2 QA data already exists; nothing added.");
    return;
  }
  const user = async (email: string) => (await q<{ id: string; email: string; full_name: string }>("select id, email, full_name from users where email = $1", [email]))[0];
  const ownerUser = await user("owner.harbor@example.test");
  const salesUser = await user("sales.harbor@example.test");
  const owner = memberActor(ctxFor(ownerUser, org, "owner"));
  const ago = (hours: number) => new Date(Date.now() - hours * 3_600_000);

  let n = 0;
  const call = (over: Partial<VoiceCallEvent> & { customerNumber: string | null; hoursAgo: number }) => {
    const started = ago(over.hoursAgo);
    const callId = `qa-call-${++n}`;
    const ev: VoiceCallEvent = {
      provider: "vapi", eventType: "end-of-call-report", receiptKey: `${callId}:end`, callId, externalIds: ["qa-assistant"], direction: "inbound", status: "no_answer", final: true,
      businessNumber: "+15125550100", startedAt: started, endedAt: new Date(started.getTime() + 20_000), durationSeconds: null, disposition: null, summary: null, recordingUrl: null, hasTranscript: false, ...over,
    };
    return withSystem((db) => recordVoiceEvent(db, { orgId: org.id, storeRecordings: false }, ev, started));
  };

  // Scoring on, so every contact below is assessed.
  const consent = (contactId: string) => q("insert into contact_consent_events (org_id, contact_id, channel, purpose, status, source) values ($1, $2, 'sms', 'service', 'granted', 'qa seed')", [org.id, contactId]);

  // 1. One caller whose follow-up fails honestly: the sending switch is off, so the text ends up blocked and the case failed.
  let policy = await savePolicy(owner, { expectedVersion: 0, enabled: true, mode: "automatic", actionMessage: true, assignUserId: salesUser.id, delayMinutes: 0 });
  policy = await activatePolicy(owner, policy.version).catch(async () => {
    await q("update missed_call_policies set activated_at = now(), activated_by = $2 where org_id = $1", [org.id, ownerUser.id]);
    return policy;
  });
  const quinn = await createContact(owner, { displayName: "Quinn Foster", phone: "+15125550130" });
  await consent(quinn.id);
  await call({ customerNumber: "+15125550130", hoursAgo: 4 });
  await processMissedCalls({ orgId: org.id });
  const queued = await q<{ id: string }>("select m.id from conversation_messages m join conversations c on c.id = m.conversation_id where c.contact_id = $1 and m.dedupe_key like 'mcc:%'", [quinn.id]);
  for (const m of queued) await dispatchMessage(m.id);
  await processMissedCalls({ orgId: org.id });

  // 2. The rest follow the safer, usual mode: a person approves each drafted text.
  const current = (await q<{ version: number }>("select version from missed_call_policies where org_id = $1", [org.id]))[0].version;
  policy = await savePolicy(owner, { expectedVersion: current, mode: "assisted", routeAppointmentSetter: false });
  await activatePolicy(owner, policy.version).catch(() => q("update missed_call_policies set activated_at = now(), activated_by = $2 where org_id = $1", [org.id, ownerUser.id]));

  // A known customer (consent on record from her earlier text): a draft is waiting for approval.
  await call({ customerNumber: "+15125550101", hoursAgo: 3 });
  // A voicemail from someone with no consent: the team is told, nothing is drafted.
  await call({ customerNumber: "+15125550177", status: "voicemail", hoursAgo: 2 });
  // A caller who withheld their number and hung up within seconds.
  await call({ customerNumber: null, status: "completed", durationSeconds: 3, disposition: "customer-ended-call", hoursAgo: 1 });
  // A caller who was then called back and answered: recovered by a person.
  const tessCall = await call({ customerNumber: "+15125550108", hoursAgo: 6 });
  void tessCall;
  await call({ customerNumber: "+15125550108", direction: "outbound", status: "completed", durationSeconds: 140, hoursAgo: 5.5 });
  // A repeat caller: two missed calls, one case.
  await call({ customerNumber: "+15125550113", hoursAgo: 0.8 });
  await call({ customerNumber: "+15125550113", status: "voicemail", hoursAgo: 0.4 });
  await processMissedCalls({ orgId: org.id });

  // 3. Lead priority for every contact, and one person's own call beside the rules.
  const contacts = await q<{ id: string }>("select id from contacts where org_id = $1 and deleted_at is null", [org.id]);
  for (const c of contacts) await assessContact(org.id, c.id);
  const maria = (await q<{ id: string }>("select id from contacts where org_id = $1 and phone = '+15125550101'", [org.id]))[0];
  if (maria) await setOverride(memberActor(ctxFor(salesUser, org, "sales_rep")), maria.id, { label: "hot", reason: "Asked for a written quote and a Thursday visit" });
  const walter = (await q<{ id: string }>("select id from contacts where org_id = $1 and phone = '+15125550110'", [org.id]))[0];
  if (walter) await setOverride(owner, walter.id, { label: "cold", reason: "Chose another company" });
  void ingestInbound;
  console.log("Phase 2 QA data is ready (missed calls, drafts, a failed follow-up, lead priorities).");
}

it.skipIf(!qaDataDir().startsWith(".data/crm-qa/"))("seeds fictional missed-call and lead-priority data into the isolated QA database", async () => {
  try {
    await seed();
  } finally {
    await closeDb();
  }
}, 240_000);
