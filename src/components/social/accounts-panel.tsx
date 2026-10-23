"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, CircleSlash, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/primitives";
import { ConfirmDialog, useCrmAction } from "@/components/crm/ui";
import { PLATFORM_LABELS, type Platform } from "@/lib/social/rules";
import { formatWhen } from "@/lib/social/calendar";
import { checkAccountAction, connectChosenAction, connectTestAccountAction, disconnectAccountAction } from "@/app/actions/social";
import type { AccountView } from "@/server/social/accounts";
import { PlatformMark } from "@/components/social/status";

// Your connected accounts and how to add one. The status is read from the platform, never assumed: an account that cannot be posted to is not shown as working,
// and says why. Connecting happens on the platform's own sign-in page; iAcquire never sees your password.

const STATUS_COPY: Record<AccountView["status"], { label: string; icon: React.ReactNode; tone: string }> = {
  connected: { label: "Connected", icon: <CheckCircle2 className="size-4" aria-hidden />, tone: "text-success-ink" },
  needs_reauth: { label: "Needs reconnecting", icon: <AlertTriangle className="size-4" aria-hidden />, tone: "text-warning-ink" },
  error: { label: "Problem", icon: <AlertTriangle className="size-4" aria-hidden />, tone: "text-warning-ink" },
  revoked: { label: "Removed on the platform", icon: <CircleSlash className="size-4" aria-hidden />, tone: "text-danger-ink" },
  disconnected: { label: "Disconnected", icon: <CircleSlash className="size-4" aria-hidden />, tone: "text-muted" },
};

export interface Choice { pageId: string; name: string; canPost: boolean; instagram: { id: string; username: string | null } | null }

export function AccountsPanel({ accounts, canConnect, metaReady, liveEnabled, tz, choose, testAccounts }: {
  accounts: AccountView[]; canConnect: boolean; metaReady: boolean; liveEnabled: boolean; tz: string;
  choose: { stateId: string; choices: Choice[] } | null; testAccounts: boolean;
}) {
  const router = useRouter();
  const { run, busy } = useCrmAction();
  const [confirm, setConfirm] = React.useState<AccountView | null>(null);
  const [picked, setPicked] = React.useState<Record<string, { on: boolean; ig: boolean }>>(() => Object.fromEntries((choose?.choices ?? []).map((c) => [c.pageId, { on: c.canPost, ig: Boolean(c.instagram) }])));
  const [testName, setTestName] = React.useState("Harbor Home (test)");
  const [testPlatform, setTestPlatform] = React.useState<Platform>("facebook");

  return (
    <div className="space-y-6">
      {choose && (
        <section aria-label="Choose what to connect" className="space-y-3 rounded-2xl border border-primary/40 bg-primary-soft/40 p-4">
          <h2 className="text-[15px] font-semibold text-ink">Choose what to connect</h2>
          <p className="text-[13px] text-ink-2">These are the Pages you manage on Facebook. Tick the ones to connect. Each is tested first, and only one that can be posted to is saved.</p>
          <ul className="space-y-2">
            {choose.choices.map((c) => (
              <li key={c.pageId} className="rounded-xl border border-line bg-surface p-3">
                <label className="flex min-h-11 items-start gap-3 text-[14px]">
                  <input type="checkbox" className="mt-1 size-5" disabled={!c.canPost} checked={Boolean(picked[c.pageId]?.on)} onChange={(e) => setPicked((p) => ({ ...p, [c.pageId]: { ...p[c.pageId], on: e.target.checked } }))} />
                  <span><span className="font-medium text-ink">{c.name}</span>{!c.canPost && <span className="block text-[12.5px] text-warning-ink">Your role on this Page does not let you publish to it. Ask a Page admin to give you the right to create content.</span>}</span>
                </label>
                {c.instagram && c.canPost && (
                  <label className="ml-8 flex min-h-11 items-center gap-3 text-[13.5px] text-ink-2">
                    <input type="checkbox" className="size-5" checked={Boolean(picked[c.pageId]?.ig)} disabled={!picked[c.pageId]?.on} onChange={(e) => setPicked((p) => ({ ...p, [c.pageId]: { ...p[c.pageId], ig: e.target.checked } }))} />
                    Also connect its Instagram account{c.instagram.username ? ` (@${c.instagram.username})` : ""}
                  </label>
                )}
              </li>
            ))}
          </ul>
          <Button variant="brand" loading={busy("choose")} disabled={!Object.values(picked).some((x) => x.on)} onClick={async () => {
            const r = await run("choose", () => connectChosenAction(choose.stateId, Object.entries(picked).filter(([, v]) => v.on).map(([pageId, v]) => ({ pageId, includeInstagram: v.ig }))));
            // Which Pages were skipped, and why, is carried by the server's notice cookie: the address only drops the used sign-in and carries no text.
            if (r) router.replace("/social/accounts");
          }}>Connect the chosen Pages</Button>
        </section>
      )}

      <section aria-label="Connected accounts" className="space-y-3">
        <h2 className="text-[15px] font-semibold text-ink">Your accounts</h2>
        {accounts.length === 0 && <p className="rounded-2xl border border-line bg-surface-2 px-4 py-3 text-[13.5px] text-ink-2">No accounts are connected yet.</p>}
        <ul className="space-y-3">
          {accounts.map((a) => {
            const st = STATUS_COPY[a.status];
            return (
              <li key={a.id} className="rounded-2xl border border-line bg-surface p-4">
                <div className="flex flex-wrap items-start gap-3">
                  <PlatformMark platform={a.platform} className="size-9 text-[13px]" />
                  <div className="min-w-0 flex-1">
                    <p className="text-[15px] font-semibold text-ink">{a.name}{a.username ? <span className="ml-1.5 text-[13px] font-normal text-muted">@{a.username}</span> : null}</p>
                    <p className="text-[12.5px] text-muted">{PLATFORM_LABELS[a.platform]}{a.adapter === "simulated" ? " · test account (posts nothing anywhere)" : ""}</p>
                    <p className={`mt-1 flex items-center gap-1.5 text-[13px] font-medium ${st.tone}`}>{st.icon}{st.label}</p>
                    {a.statusDetail && <p className="mt-0.5 text-[12.5px] text-ink-2">{a.statusDetail}</p>}
                    <dl className="mt-2 grid gap-x-6 gap-y-1 text-[12.5px] text-muted sm:grid-cols-2">
                      <div><dt className="inline">Last checked: </dt><dd className="inline text-ink-2">{a.lastCheckedAt ? formatWhen(a.lastCheckedAt, tz) : "not yet"}</dd></div>
                      <div><dt className="inline">Can post: </dt><dd className="inline text-ink-2">{a.capabilities.contentTypes.length ? a.capabilities.contentTypes.join(", ") : "nothing right now"}</dd></div>
                      {a.quota && <div><dt className="inline">Posting limit: </dt><dd className="inline text-ink-2">{a.quota.usage} of {a.quota.total} used (as the platform reports it)</dd></div>}
                      {a.dataAccessExpiresAt && <div><dt className="inline">Access renewal: </dt><dd className="inline text-ink-2">{formatWhen(a.dataAccessExpiresAt, tz)}</dd></div>}
                    </dl>
                  </div>
                  {canConnect && a.status !== "disconnected" && a.status !== "revoked" && (
                    <div className="flex flex-wrap gap-2">
                      {/* Every account has the same two buttons, so a screen reader needs the account in each name (the visible words stay first). */}
                      <Button size="sm" variant="secondary" aria-label={`Test connection for ${a.name} (${PLATFORM_LABELS[a.platform]})`} loading={busy(`check-${a.id}`)} onClick={() => run(`check-${a.id}`, () => checkAccountAction(a.id), "Checked.")}>Test connection</Button>
                      <Button size="sm" variant="outline" aria-label={`Disconnect ${a.name} (${PLATFORM_LABELS[a.platform]})`} onClick={() => setConfirm(a)}>Disconnect</Button>
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </section>

      {canConnect ? (
        <section aria-label="Connect an account" className="space-y-3 rounded-2xl border border-line bg-surface p-4">
          <h2 className="text-[15px] font-semibold text-ink">Connect a Facebook Page</h2>
          {metaReady ? (
            <>
              <p className="text-[13px] text-ink-2">You will sign in on Facebook&apos;s own page and choose which Pages to share. The Instagram professional account linked to a Page can be connected with it.</p>
              <div className="flex flex-wrap gap-2">
                <a href="/api/social/oauth/meta/start?platform=instagram" className="inline-flex min-h-11 items-center rounded-xl brand-gradient px-4 text-[13.5px] font-medium text-white shadow-glow sm:min-h-10">Connect Facebook and Instagram</a>
                <a href="/api/social/oauth/meta/start?platform=facebook" className="inline-flex min-h-11 items-center rounded-xl border border-line bg-surface px-4 text-[13.5px] font-medium text-ink hover:bg-surface-2 sm:min-h-10">Connect a Facebook Page only</a>
              </div>
            </>
          ) : (
            <p className="rounded-xl bg-surface-2 px-3 py-2.5 text-[13px] text-ink-2">Connecting Facebook and Instagram is not available yet. iAcquire has to register its app with Meta (and have its permissions approved) before any account can be connected. Nothing is lost by waiting: your drafts and calendar work now.</p>
          )}
          {!liveEnabled && <p className="text-[12.5px] text-muted">Even once connected, publishing to real accounts stays switched off until iAcquire turns it on for this environment.</p>}
        </section>
      ) : (
        <p className="text-[13px] text-muted">Only the business owner or a manager can connect or disconnect accounts.</p>
      )}

      {canConnect && testAccounts && (
        <section aria-label="Add a test account" className="space-y-3 rounded-2xl border border-dashed border-line-strong p-4">
          <h2 className="text-[14px] font-semibold text-ink">Add a test account</h2>
          <p className="text-[12.5px] text-muted">For trying the calendar and approvals. A test account posts nothing anywhere. It does not exist in production.</p>
          <div className="grid gap-3 sm:grid-cols-[1fr_180px_auto] sm:items-end">
            <Field label="Name" htmlFor="ta-name"><Input id="ta-name" value={testName} maxLength={120} onChange={(e) => setTestName(e.target.value)} className="text-[16px] sm:text-[14px]" /></Field>
            <Field label="Platform" htmlFor="ta-platform">
              <Select id="ta-platform" value={testPlatform} onChange={(e) => setTestPlatform(e.target.value as Platform)}>
                <option value="facebook">Facebook Page</option>
                <option value="instagram">Instagram</option>
              </Select>
            </Field>
            <Button variant="secondary" loading={busy("test")} disabled={!testName.trim()} onClick={() => run("test", () => connectTestAccountAction({ platform: testPlatform, name: testName }), "Test account added.")}>Add test account</Button>
          </div>
        </section>
      )}

      <ConfirmDialog
        open={Boolean(confirm)} onOpenChange={(o) => !o && setConfirm(null)} title={`Disconnect ${confirm?.name ?? "this account"}?`} confirmLabel="Disconnect" danger loading={busy("disconnect")}
        description="Anything scheduled for it will not be published. Posts already on the platform stay there. To remove iAcquire's access completely, also remove the app in your Facebook settings."
        onConfirm={async () => { if (!confirm) return; await run("disconnect", () => disconnectAccountAction(confirm.id), "Disconnected."); setConfirm(null); }}
      />
    </div>
  );
}
