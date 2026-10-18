import "server-only";
import { withSystem, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { notifyAgency, notifyOrgRoles } from "@/server/notifications";
import { assertCredentialAdmin, encodeCredentialSecret, resolveCredential, revokeCredential, saveCredential } from "@/server/security/credentials";
import { capabilityTesterFor, isNativeTransport, isTransportName, PROVIDERS_FOR_CHANNEL, transportWritesEnabled, type CapabilityTester, type NativeTransportName } from "@/server/messaging/transports";
import { TRANSPORT_LABELS, type CapabilityTest, type TransportName } from "@/server/messaging/transports/types";
import { CHANNELS, CHANNEL_LABELS, isChannel, normalizeEmail, normalizePhone, type Channel } from "@/lib/messaging";
import type { SessionUser } from "@/server/auth/service";
import { pickUpSetupEvidence } from "@/server/setup/evidence-pickup";
import { nativeChannelRefusal } from "@/server/crm/provider-guard";
import { loadWorkspace } from "@/server/crm/workspace";

// Channel setup for the native transports (Resend email, Twilio SMS, Meta WhatsApp), next to GoHighLevel.
//
// Who does what: storing a provider credential, testing it and switching a native channel on is an iAcquire agency super admin's job
// (assertCredentialAdmin, the same rule as every other stored credential). A client's owners and managers can see each channel's status
// and switch a channel off (src/server/messaging/inbox.ts setChannelEnabled); they never see or handle a secret.
//
// The order is fixed and the database enforces the end of it (messaging_channels_native_ready): a native channel is enabled only with a
// stored credential, a named sender and a passed capability test. The test is authenticated with the workspace's own credential and only
// reads from the provider; it never sends a message.

export type ChannelAdmin = Pick<SessionUser, "id" | "platformRole">;

const SENDER_ID: Record<NativeTransportName, { re: RegExp; hint: string }> = {
  resend: { re: /^[0-9A-Fa-f-]{8,64}$/, hint: "the Resend domain id (Domains → your domain)" },
  twilio: { re: /^(?:MG[0-9a-fA-F]{32}|\+[1-9]\d{6,14})$/, hint: "a Twilio Messaging Service SID (MG…) or the Twilio number in international format (+…)" },
  meta_whatsapp: { re: /^\d{5,30}$/, hint: "the WhatsApp phone number ID from Meta (digits only)" },
};
const ACCOUNT_ID: Record<NativeTransportName, { re: RegExp; hint: string } | null> = {
  resend: null,
  twilio: { re: /^AC[0-9a-fA-F]{32}$/, hint: "the Twilio Account SID (AC…)" },
  meta_whatsapp: { re: /^\d{5,30}$/, hint: "the WhatsApp Business Account ID (digits only)" },
};

export interface NativeChannelInput {
  channel: Channel;
  provider: NativeTransportName;
  /**
   * The provider credential. A single key (Resend) as a string; a credential of several parts (Twilio account SID and auth token, a Meta
   * access token and app secret) as an object of strings, stored as one vault secret. Leave it out to keep the stored credential.
   */
  secret?: string | Record<string, string> | null;
  /** What the customer sees: "Name <hello@example.com>" for email, the number in international format for SMS and WhatsApp. */
  senderIdentity: string;
  senderId: string;
  accountId?: string | null;
  /** Email only: the address customers write to, when inbound email is routed to iAcquire through Resend. */
  inboundAddress?: string | null;
  /**
   * The channel is live right now (through GoHighLevel or a native provider), and this save changes something the provider test checked.
   * That switches it off until the new setup passes its test and is switched on again, so it has to be confirmed.
   */
  replaceLiveChannel?: boolean;
}

/** The address or number customers see, without an email's display name: what a provider test checks about the sender. */
function senderAddressOf(channel: Channel, identity: string | null): string | null {
  if (!identity) return null;
  if (channel !== "email") return normalizePhone(identity);
  const named = /^(.*?)\s*<([^<>]+)>$/.exec(identity.trim());
  return normalizeEmail(named ? named[2] : identity);
}

interface ChannelRow {
  channel: Channel;
  provider: string;
  enabled: boolean;
  sender_identity: string | null;
  sender_verified_at: Date | null;
  registration_status: string;
  last_checked_at: Date | null;
  detail: string | null;
  provider_sender_id: string | null;
  provider_account_id: string | null;
  credential_id: string | null;
  inbound_address: string | null;
  capability_test: unknown;
  capability_tested_at: Date | null;
  credential_live: boolean | null;
  credential_saved_at: Date | null;
}

const ROW_COLUMNS = `mc.channel, mc.provider, mc.enabled, mc.sender_identity, mc.sender_verified_at, mc.registration_status, mc.last_checked_at, mc.detail,
  mc.provider_sender_id, mc.provider_account_id, mc.credential_id, mc.inbound_address::text as inbound_address, mc.capability_test, mc.capability_tested_at,
  (c.id is not null and c.revoked_at is null) as credential_live, c.created_at as credential_saved_at`;

async function loadRow(db: Queryable, orgId: string, channel: Channel, lock = false): Promise<ChannelRow | null> {
  const { rows } = await db.query<ChannelRow>(
    `select ${ROW_COLUMNS} from messaging_channels mc left join integration_credentials c on c.id = mc.credential_id where mc.org_id = $1 and mc.channel = $2${lock ? " for update of mc" : ""}`,
    [orgId, channel],
  );
  return rows[0] ?? null;
}

const providerOf = (row: Pick<ChannelRow, "provider"> | null): TransportName => (row && isTransportName(row.provider) ? row.provider : "ghl");
const isUniqueViolation = (err: unknown) => typeof err === "object" && err !== null && (err as { code?: unknown }).code === "23505";
const isCheckViolation = (err: unknown) => typeof err === "object" && err !== null && (err as { code?: unknown }).code === "23514";

function assertChannel(channel: unknown): asserts channel is Channel {
  if (!isChannel(channel)) throw new AppError("invalid_input", "Choose SMS, WhatsApp or email.");
}

async function assertClient(db: Queryable, orgId: string) {
  const { rows } = await db.query("select 1 from organizations where id = $1 and kind = 'client'", [orgId]);
  if (!rows[0]) throw new AppError("not_found", "Workspace not found.");
}

/** The sender as the customer sees it, validated for the channel. Email keeps a display name ("Name <address>") when one is given. */
export function normalizeSenderIdentity(channel: Channel, raw: string): string | null {
  const value = raw.replace(/\s+/g, " ").trim();
  if (!value || value.length > 200) return null;
  if (channel !== "email") {
    const phone = normalizePhone(value);
    return phone && /^\+[1-9]\d{6,14}$/.test(phone) ? phone : null;
  }
  const named = /^(.*?)\s*<([^<>]+)>$/.exec(value);
  const address = normalizeEmail(named ? named[2] : value);
  if (!address) return null;
  const name = named?.[1]?.replace(/^"|"$/g, "").trim() ?? "";
  if (/[<>"\u0000-\u001f]/.test(name) || name.length > 100) return null;
  return name ? `${name} <${address}>` : address;
}

/** What configureNativeChannel accepts, checked before anything is stored. */
export function validateNativeChannel(input: NativeChannelInput): { channel: Channel; provider: NativeTransportName; senderIdentity: string; senderId: string; accountId: string | null; inboundAddress: string | null } {
  assertChannel(input.channel);
  if (!isNativeTransport(input.provider) || !PROVIDERS_FOR_CHANNEL[input.channel].includes(input.provider)) {
    throw new AppError("invalid_input", `${CHANNEL_LABELS[input.channel]} can't be sent through ${isTransportName(input.provider) ? TRANSPORT_LABELS[input.provider] : "that provider"}.`);
  }
  const provider = input.provider;
  const senderIdentity = normalizeSenderIdentity(input.channel, input.senderIdentity ?? "");
  if (!senderIdentity) throw new AppError("invalid_input", input.channel === "email" ? "Enter the from-address, for example Mango Clinic <hello@mangoclinic.com>." : "Enter the sending number in international format, for example +639171234567.");
  const senderId = (input.senderId ?? "").trim();
  if (!SENDER_ID[provider].re.test(senderId)) throw new AppError("invalid_input", `Enter ${SENDER_ID[provider].hint}.`);
  const accountRule = ACCOUNT_ID[provider];
  const accountId = input.accountId?.trim() || null;
  if (accountRule && accountId && !accountRule.re.test(accountId)) throw new AppError("invalid_input", `Enter ${accountRule.hint}.`);
  if (provider === "meta_whatsapp" && !accountId) throw new AppError("invalid_input", `Enter ${ACCOUNT_ID.meta_whatsapp!.hint}: approved templates live there.`);
  if (!accountRule && accountId) throw new AppError("invalid_input", `${TRANSPORT_LABELS[provider]} has no account id to enter.`);
  let inboundAddress: string | null = null;
  if (input.inboundAddress?.trim()) {
    if (input.channel !== "email") throw new AppError("invalid_input", "Only email has a receiving address.");
    inboundAddress = normalizeEmail(input.inboundAddress);
    if (!inboundAddress || inboundAddress.length > 320) throw new AppError("invalid_input", "Enter the address customers email, for example replies@mangoclinic.com.");
  }
  return { channel: input.channel, provider, senderIdentity, senderId, accountId, inboundAddress };
}

/**
 * Sets a workspace's channel up to send through its native provider: stores the credential in the vault (replacing and revoking the
 * previous one when a new secret is given) and records the sender. A change to anything the provider test checked (provider, credential,
 * sender id, account, receiving address, or the address or number customers see) leaves the channel switched off and untested: the earlier
 * result no longer applies. Saving the same setup again (for example only a new display name on the from-address) keeps the channel's
 * state, on or off. Switching off a live channel has to be confirmed (replaceLiveChannel). Agency super admins only.
 */
export async function configureNativeChannel(admin: ChannelAdmin, orgId: string, input: NativeChannelInput): Promise<ChannelStatus> {
  const v = validateNativeChannel(input);
  const secretText = input.secret == null ? null : typeof input.secret === "string" ? input.secret : encodeCredentialSecret(input.secret);
  return withSystem(async (db) => {
    await assertCredentialAdmin(db, admin.id);
    await assertClient(db, orgId);
    const current = await loadRow(db, orgId, v.channel, true);
    const currentProvider = providerOf(current);
    const unchanged = Boolean(
      current &&
        currentProvider === v.provider &&
        !secretText &&
        current.credential_id &&
        current.credential_live &&
        current.provider_sender_id === v.senderId &&
        (current.provider_account_id ?? null) === v.accountId &&
        (current.inbound_address?.toLowerCase() ?? null) === (v.inboundAddress?.toLowerCase() ?? null) &&
        senderAddressOf(v.channel, current.sender_identity) === senderAddressOf(v.channel, v.senderIdentity),
    );
    if (current && unchanged) {
      // Nothing the provider test checked changed, so its result (and the channel being on or off) still applies.
      await db.query("update messaging_channels set sender_identity = $3 where org_id = $1 and channel = $2", [orgId, v.channel, v.senderIdentity]);
      await recordAudit(
        { orgId, actorUserId: admin.id, actorKind: "agency", action: "messaging.channel_configured", targetType: "messaging_channel", targetId: v.channel, result: "success", metadata: { provider: v.provider, previousProvider: currentProvider, credentialReplaced: false, keptTestResult: true } },
        db,
      );
      return statusOf(v.channel, await loadRow(db, orgId, v.channel));
    }
    if (current?.enabled && !input.replaceLiveChannel) {
      const via = TRANSPORT_LABELS[currentProvider];
      throw new AppError(
        "conflict",
        currentProvider === v.provider
          ? `${CHANNEL_LABELS[v.channel]} is live through ${via}. Saving this change switches it off until ${via} passes its test again and it's switched back on. Confirm to continue.`
          : `${CHANNEL_LABELS[v.channel]} is live through ${via}. Moving it to ${TRANSPORT_LABELS[v.provider]} stops ${CHANNEL_LABELS[v.channel]} messages until ${TRANSPORT_LABELS[v.provider]} passes its test and is switched on. Confirm to continue.`,
      );
    }
    // A credential belongs to one provider: switching providers needs a new one.
    const keep = current && currentProvider === v.provider && current.credential_id && current.credential_live ? current.credential_id : null;
    if (!secretText && !keep) throw new AppError("invalid_input", `Enter the ${TRANSPORT_LABELS[v.provider]} credential.`);

    let credentialId = keep;
    if (secretText) {
      const saved = await saveCredential(db, {
        orgId,
        provider: v.provider,
        label: `${TRANSPORT_LABELS[v.provider]} ${CHANNEL_LABELS[v.channel]}`,
        secret: secretText,
        actorId: admin.id,
        replaces: keep,
      });
      credentialId = saved.id;
    }
    // A credential of another provider left behind by an earlier setup is withdrawn, so nothing can resolve it any more.
    if (current?.credential_id && current.credential_live && current.credential_id !== credentialId && current.credential_id !== keep && isNativeTransport(currentProvider)) {
      await revokeCredential(db, current.credential_id, orgId, currentProvider, admin.id);
    }

    await db.query("insert into messaging_settings (org_id) values ($1) on conflict do nothing", [orgId]);
    try {
      await db.query(
        `insert into messaging_channels (org_id, channel, provider, enabled, sender_identity, provider_sender_id, provider_account_id, credential_id, inbound_address,
           sender_verified_at, registration_status, capability_test, capability_tested_at, last_checked_at, detail)
         values ($1, $2, $3, false, $4, $5, $6, $7, $8, null, 'not_started', '{}'::jsonb, null, null, $9)
         on conflict (org_id, channel) do update set provider = excluded.provider, enabled = false, sender_identity = excluded.sender_identity,
           provider_sender_id = excluded.provider_sender_id, provider_account_id = excluded.provider_account_id, credential_id = excluded.credential_id,
           inbound_address = excluded.inbound_address, sender_verified_at = null, registration_status = 'not_started', capability_test = '{}'::jsonb,
           capability_tested_at = null, last_checked_at = null, detail = excluded.detail`,
        [orgId, v.channel, v.provider, v.senderIdentity, v.senderId, v.accountId, credentialId, v.inboundAddress, `Set up for ${TRANSPORT_LABELS[v.provider]}. Run the channel test before switching it on.`],
      );
    } catch (err) {
      if (isUniqueViolation(err)) throw new AppError("conflict", "That sender or receiving address is already connected to another workspace.");
      throw err;
    }
    await recordAudit(
      {
        orgId,
        actorUserId: admin.id,
        actorKind: "agency",
        action: "messaging.channel_configured",
        targetType: "messaging_channel",
        targetId: v.channel,
        result: "success",
        metadata: { provider: v.provider, previousProvider: current ? currentProvider : null, credentialReplaced: Boolean(secretText), inboundAddress: Boolean(v.inboundAddress) },
      },
      db,
    );
    return statusOf(v.channel, await loadRow(db, orgId, v.channel));
  });
}

/** The capability test result as stored: what was checked, never a secret, within the column's size limit. */
function storableTest(test: CapabilityTest, now: Date): Record<string, unknown> {
  const checks = (Array.isArray(test.checks) ? test.checks : []).slice(0, 12).map((c) => ({ label: String(c.label ?? "").slice(0, 80), ok: c.ok === true, detail: String(c.detail ?? "").slice(0, 240) }));
  const out: Record<string, unknown> = { ok: test.ok === true, checkedAt: (test.checkedAt && !Number.isNaN(Date.parse(test.checkedAt)) ? new Date(test.checkedAt) : now).toISOString(), checks };
  if (test.registrationStatus) out.registrationStatus = test.registrationStatus;
  // Stay well within the 4 KB the column allows: shorten details first, then drop checks from the end.
  while (Buffer.byteLength(JSON.stringify(out), "utf8") > 3500 && checks.length) {
    const longest = checks.reduce((a, b) => (b.detail.length > a.detail.length ? b : a));
    if (longest.detail.length > 80) longest.detail = `${longest.detail.slice(0, Math.floor(longest.detail.length / 2))}…`;
    else checks.pop();
  }
  return out;
}

const REGISTRATION = new Set(["not_required", "pending", "approved", "rejected"]);

/**
 * Runs the provider's authenticated capability test for a native channel with the workspace's own stored credential. The provider is
 * called outside any transaction. The result is always recorded; only a passing test sets the tested and verified times and the
 * registration status that switching the channel on depends on. A failing test clears them and switches the channel off if it was on
 * (owners and the agency are notified). Agency super admins only.
 */
export async function runChannelCapabilityTest(admin: ChannelAdmin, orgId: string, channel: Channel, deps: { test?: CapabilityTester; now?: () => Date } = {}): Promise<{ ok: boolean; test: CapabilityTest; status: ChannelStatus }> {
  assertChannel(channel);
  const now = deps.now ?? (() => new Date());
  const prepared = await withSystem(async (db) => {
    await assertCredentialAdmin(db, admin.id);
    const row = await loadRow(db, orgId, channel);
    const provider = providerOf(row);
    if (!row || !isNativeTransport(provider)) throw new AppError("conflict", `${CHANNEL_LABELS[channel]} isn't set up for a native provider. GoHighLevel channels are checked in GoHighLevel.`);
    if (!row.credential_id || !row.credential_live) throw new AppError("conflict", `There is no ${TRANSPORT_LABELS[provider]} credential for this channel. Save it again.`);
    if (!row.provider_sender_id || !row.sender_identity) throw new AppError("conflict", "Finish the sender details before testing.");
    const secret = await resolveCredential(db, row.credential_id, orgId, provider);
    if (!secret) throw new AppError("conflict", `The stored ${TRANSPORT_LABELS[provider]} credential can't be read. Save it again.`);
    return { row, provider, secret };
  });
  const { row, provider } = prepared;
  const tester = deps.test ?? (await capabilityTesterFor(provider));
  let test: CapabilityTest;
  try {
    test = await tester({
      orgId,
      channel,
      secret: prepared.secret,
      sender: { identity: row.sender_identity, senderId: row.provider_sender_id, accountId: row.provider_account_id, credentialId: row.credential_id },
      senderIdentity: row.sender_identity!,
      senderId: row.provider_sender_id!,
      accountId: row.provider_account_id,
      inboundAddress: row.inbound_address,
    });
  } catch (err) {
    // The provider package failed in a way it did not report itself. Never echo the error: it could carry a request detail.
    console.error("[iacquire] channel capability test threw", { provider, channel, error: err instanceof Error ? err.name : "unknown" });
    test = { ok: false, checkedAt: now().toISOString(), checks: [{ label: "Test", ok: false, detail: `The ${TRANSPORT_LABELS[provider]} test couldn't finish. Try again in a few minutes.` }] };
  }
  const passed = test.ok === true && Array.isArray(test.checks) && test.checks.length > 0 && test.checks.every((c) => c.ok === true);
  const stored = storableTest({ ...test, ok: passed }, now());

  const status = await withSystem(async (db) => {
    const current = await loadRow(db, orgId, channel, true);
    // The setup changed while the provider was being asked: this result is about something else now.
    if (!current || current.provider !== provider || current.credential_id !== row.credential_id || current.provider_sender_id !== row.provider_sender_id || current.provider_account_id !== row.provider_account_id) {
      throw new AppError("conflict", "The channel was changed while it was being tested. Run the test again.");
    }
    const failedCheck = (Array.isArray(test.checks) ? test.checks : []).find((c) => !c.ok);
    const detail = passed ? `${TRANSPORT_LABELS[provider]} test passed.` : `${TRANSPORT_LABELS[provider]} test failed: ${failedCheck ? `${failedCheck.label}. ${failedCheck.detail}` : "the provider did not confirm the setup."}`;
    if (passed) {
      const registration = test.registrationStatus && REGISTRATION.has(test.registrationStatus) ? test.registrationStatus : channel === "email" ? "not_required" : "pending";
      const identity = test.senderIdentity ? normalizeSenderIdentity(channel, test.senderIdentity) : null;
      const account = test.accountId?.trim() || null;
      try {
        await db.query(
          `update messaging_channels set capability_test = $3::jsonb, capability_tested_at = $4, sender_verified_at = $4, registration_status = $5, last_checked_at = $4, detail = $6,
             sender_identity = coalesce($7, sender_identity), provider_account_id = coalesce($8, provider_account_id), provider_sender_id = coalesce($9, provider_sender_id)
           where org_id = $1 and channel = $2`,
          [orgId, channel, JSON.stringify(stored), now(), registration, detail.slice(0, 300), identity, account && account.length <= 200 ? account : null, test.senderId?.trim() && test.senderId.trim().length <= 200 ? test.senderId.trim() : null],
        );
      } catch (err) {
        if (isUniqueViolation(err)) throw new AppError("conflict", "The provider reports a sender that is already connected to another workspace.");
        throw err;
      }
    } else {
      // A failed test withdraws the earlier pass: the channel can't be switched on with it, and a channel that is on is switched off.
      // Sending with a credential or sender the provider has just refused would fail, or worse, half work (a WhatsApp number whose webhook
      // subscription is gone keeps sending while customers' STOP replies never arrive). Owners and the agency are told.
      const wasOn = current.enabled;
      await db.query(
        `update messaging_channels set capability_test = $3::jsonb, last_checked_at = $4, detail = $5, capability_tested_at = null, sender_verified_at = null, enabled = false
         where org_id = $1 and channel = $2`,
        [orgId, channel, JSON.stringify(stored), now(), `${detail}${wasOn ? " The channel was switched off." : ""}`.slice(0, 300)],
      );
      if (wasOn) {
        const label = TRANSPORT_LABELS[provider];
        const day = now().toISOString().slice(0, 10);
        await notifyOrgRoles(db, orgId, ["owner", "admin"], {
          kind: "integration_reconnect_required",
          severity: "warning",
          title: `${CHANNEL_LABELS[channel]} was switched off`,
          body: `The ${label} connection test didn't pass, so ${CHANNEL_LABELS[channel]} messages are held until iAcquire fixes the connection and switches it on again.`,
          link: "/crm/settings/communications",
          dedupeKey: `channel_test_failed:${channel}:${day}`,
        });
        await notifyAgency(db, orgId, {
          kind: "integration_reconnect_required",
          severity: "warning",
          title: `${label} test failed: ${CHANNEL_LABELS[channel]} switched off for a client`,
          body: `${failedCheck ? `${failedCheck.label}: ${failedCheck.detail}` : "The provider did not confirm the setup."}`.slice(0, 300),
          link: `/admin/clients/${orgId}/communications`,
          dedupeKey: `channel_test_failed:${provider}:${orgId}:${day}`,
        });
        await recordAudit({ orgId, actorUserId: admin.id, actorKind: "agency", action: "messaging.channel_disabled", targetType: "messaging_channel", targetId: channel, result: "success", metadata: { provider, reason: "capability_test_failed" } }, db);
      }
    }
    await recordAudit(
      {
        orgId,
        actorUserId: admin.id,
        actorKind: "agency",
        action: "messaging.channel_tested",
        targetType: "messaging_channel",
        targetId: channel,
        result: passed ? "success" : "failure",
        metadata: { provider, checks: (stored.checks as Array<{ label: string; ok: boolean }>).map((c) => ({ label: c.label, ok: c.ok })) },
      },
      db,
    );
    return statusOf(channel, await loadRow(db, orgId, channel));
  });
  // Committed: the Setup Center's sender check sees this result now rather than at the next scheduled pass (never failing the test).
  await pickUpSetupEvidence(orgId, "a channel capability test");
  return { ok: passed, test: { ...test, ok: passed }, status };
}

/** Why a channel can't be switched on yet, in plain words. Empty when it can. */
function readinessIssues(row: ChannelRow | null, nativeRefusal: string | null = null): string[] {
  if (!row) return ["The channel hasn't been set up."];
  const provider = providerOf(row);
  const issues: string[] = [];
  if (isNativeTransport(provider)) {
    if (nativeRefusal) issues.push(nativeRefusal);
    if (!row.credential_id || !row.credential_live) issues.push(`There is no ${TRANSPORT_LABELS[provider]} credential.`);
    if (!row.provider_sender_id) issues.push("The sender isn't named.");
    // The latest test decides (the database checks the same): a pass followed by a failed re-test is not a pass.
    const t = row.capability_test && typeof row.capability_test === "object" && !Array.isArray(row.capability_test) ? (row.capability_test as { ok?: unknown }) : null;
    if (t && "ok" in t && t.ok !== true) issues.push(`The last ${TRANSPORT_LABELS[provider]} test didn't pass.`);
    else if (!row.capability_tested_at || t?.ok !== true) issues.push(`The ${TRANSPORT_LABELS[provider]} test hasn't passed.`);
  }
  if (!row.sender_verified_at) issues.push("The sender isn't verified.");
  if (row.channel !== "email" && !["not_required", "approved"].includes(row.registration_status)) {
    issues.push(row.registration_status === "pending" ? "Sender registration is still pending with the carrier or Meta." : row.registration_status === "rejected" ? "Sender registration was rejected." : "Sender registration hasn't started.");
  }
  return issues;
}

/**
 * Switches a channel on. A native channel needs its credential, sender and a passed test (the database refuses otherwise); the refusal says
 * what is missing. Agency super admins only: a client's owner can switch a channel off but not on again once it is native.
 */
export async function enableChannel(admin: ChannelAdmin, orgId: string, channel: Channel): Promise<ChannelStatus> {
  assertChannel(channel);
  return withSystem(async (db) => {
    await assertCredentialAdmin(db, admin.id);
    await loadWorkspace(db, orgId);
    await db.query("select org_id from crm_workspaces where org_id = $1 for update", [orgId]);
    const row = await loadRow(db, orgId, channel, true);
    const issues = readinessIssues(row, await nativeChannelRefusal(db, orgId));
    if (issues.length) throw new AppError("conflict", `${CHANNEL_LABELS[channel]} can't be switched on yet. ${issues.join(" ")}`);
    try {
      await db.query("update messaging_channels set enabled = true where org_id = $1 and channel = $2", [orgId, channel]);
    } catch (err) {
      if (isCheckViolation(err)) throw new AppError("conflict", `${CHANNEL_LABELS[channel]} can't be switched on until its credential, sender and test are all in place.`);
      throw err;
    }
    await recordAudit({ orgId, actorUserId: admin.id, actorKind: "agency", action: "messaging.channel_enabled", targetType: "messaging_channel", targetId: channel, result: "success", metadata: { provider: providerOf(row) } }, db);
    return statusOf(channel, await loadRow(db, orgId, channel));
  });
}

/** Switches a channel off. Queued messages for it are held with the reason when they come due. Agency super admins only. */
export async function disableChannel(admin: ChannelAdmin, orgId: string, channel: Channel): Promise<ChannelStatus> {
  assertChannel(channel);
  return withSystem(async (db) => {
    await assertCredentialAdmin(db, admin.id);
    const row = await loadRow(db, orgId, channel, true);
    if (!row) throw new AppError("not_found", `${CHANNEL_LABELS[channel]} isn't set up for this workspace.`);
    await db.query("update messaging_channels set enabled = false where org_id = $1 and channel = $2", [orgId, channel]);
    await recordAudit({ orgId, actorUserId: admin.id, actorKind: "agency", action: "messaging.channel_disabled", targetType: "messaging_channel", targetId: channel, result: "success", metadata: { provider: providerOf(row) } }, db);
    return statusOf(channel, await loadRow(db, orgId, channel));
  });
}

/**
 * Moves a channel back to GoHighLevel. The native setup is cleared and its credential revoked, and the channel stays off until its
 * GoHighLevel sender is verified again (the agency's sender attestation). Agency super admins only.
 */
export async function switchChannelToGhl(admin: ChannelAdmin, orgId: string, channel: Channel): Promise<ChannelStatus> {
  assertChannel(channel);
  return withSystem(async (db) => {
    await assertCredentialAdmin(db, admin.id);
    const row = await loadRow(db, orgId, channel, true);
    const provider = providerOf(row);
    if (!row || provider === "ghl") throw new AppError("conflict", `${CHANNEL_LABELS[channel]} already uses GoHighLevel.`);
    await db.query(
      `update messaging_channels set provider = 'ghl', enabled = false, provider_sender_id = null, provider_account_id = null, credential_id = null, inbound_address = null,
         capability_test = '{}'::jsonb, capability_tested_at = null, sender_verified_at = null, sender_identity = null, registration_status = 'not_started', last_checked_at = null,
         detail = 'Moved back to GoHighLevel. Verify the GoHighLevel sender before switching it on.'
       where org_id = $1 and channel = $2`,
      [orgId, channel],
    );
    if (row.credential_id && row.credential_live) await revokeCredential(db, row.credential_id, orgId, provider, admin.id);
    await recordAudit({ orgId, actorUserId: admin.id, actorKind: "agency", action: "messaging.channel_switched", targetType: "messaging_channel", targetId: channel, result: "success", metadata: { from: provider, to: "ghl" } }, db);
    return statusOf(channel, await loadRow(db, orgId, channel));
  });
}

/** A channel as the setup screens show it. Never contains a secret: only whether a credential is stored, and when. */
export interface ChannelStatus {
  channel: Channel;
  channelLabel: string;
  provider: TransportName;
  providerLabel: string;
  native: boolean;
  enabled: boolean;
  senderIdentity: string | null;
  senderId: string | null;
  accountId: string | null;
  inboundAddress: string | null;
  credentialStored: boolean;
  credentialSavedAt: string | null;
  senderVerifiedAt: string | null;
  registrationStatus: string;
  testedAt: string | null;
  lastCheckedAt: string | null;
  lastTest: { ok: boolean; checkedAt: string | null; checks: Array<{ label: string; ok: boolean; detail: string }> } | null;
  /** Everything needed to switch it on is in place. */
  ready: boolean;
  readinessIssues: string[];
  /** The deployment's kill switch for this provider (RESEND_WRITES_ENABLED, …). When off, nothing is sent even if the channel is on. */
  sendingAllowedHere: boolean;
  detail: string | null;
}

const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);

function lastTestOf(raw: unknown): ChannelStatus["lastTest"] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || !("checks" in raw)) return null;
  const t = raw as { ok?: unknown; checkedAt?: unknown; checks?: unknown };
  const checks = Array.isArray(t.checks)
    ? t.checks.filter((c): c is { label: unknown; ok: unknown; detail: unknown } => Boolean(c) && typeof c === "object").map((c) => ({ label: String(c.label ?? ""), ok: c.ok === true, detail: String(c.detail ?? "") }))
    : [];
  return { ok: t.ok === true, checkedAt: typeof t.checkedAt === "string" ? t.checkedAt : null, checks };
}

function statusOf(channel: Channel, row: ChannelRow | null, nativeRefusal: string | null = null): ChannelStatus {
  const provider = providerOf(row);
  const issues = readinessIssues(row, nativeRefusal);
  return {
    channel,
    channelLabel: CHANNEL_LABELS[channel],
    provider,
    providerLabel: TRANSPORT_LABELS[provider],
    native: provider !== "ghl",
    enabled: row?.enabled ?? false,
    senderIdentity: row?.sender_identity ?? null,
    senderId: row?.provider_sender_id ?? null,
    accountId: row?.provider_account_id ?? null,
    inboundAddress: row?.inbound_address ?? null,
    credentialStored: Boolean(row?.credential_id && row.credential_live),
    credentialSavedAt: row?.credential_id && row.credential_live ? iso(row.credential_saved_at) : null,
    senderVerifiedAt: iso(row?.sender_verified_at ?? null),
    registrationStatus: row?.registration_status ?? "not_started",
    testedAt: iso(row?.capability_tested_at ?? null),
    lastCheckedAt: iso(row?.last_checked_at ?? null),
    lastTest: lastTestOf(row?.capability_test),
    ready: issues.length === 0,
    readinessIssues: issues,
    sendingAllowedHere: transportWritesEnabled(provider),
    detail: row?.detail ?? null,
  };
}

/**
 * Every channel's setup and status for one workspace, for the setup screens (agency) and the client's messaging settings. The caller
 * authorizes the reader; nothing returned is secret.
 */
export async function listChannelStatus(orgId: string, db?: Queryable): Promise<ChannelStatus[]> {
  const read = async (q: Queryable) => {
    const { rows } = await q.query<ChannelRow>(`select ${ROW_COLUMNS} from messaging_channels mc left join integration_credentials c on c.id = mc.credential_id where mc.org_id = $1`, [orgId]);
    const nativeRefusal = await nativeChannelRefusal(q, orgId);
    return CHANNELS.map((channel) => statusOf(channel, rows.find((r) => r.channel === channel) ?? null, nativeRefusal));
  };
  return db ? read(db) : withSystem(read);
}
