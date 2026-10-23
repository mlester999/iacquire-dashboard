import { cookies } from "next/headers";
import { PlugZap } from "lucide-react";
import { requireOrgContext } from "@/server/tenancy/context";
import { AppError } from "@/server/errors";
import { listAccounts, pendingChoices } from "@/server/social/accounts";
import { livePublishingEnabled, simulatedAllowed } from "@/server/social/providers";
import { metaConfigured } from "@/server/social/providers/meta-oauth";
import { decodeSocialNotice, SOCIAL_NOTICE_COOKIE } from "@/server/social/notice";
import { AccountsPanel } from "@/components/social/accounts-panel";

export const metadata = { title: "Social accounts" };

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function SocialAccountsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requireOrgContext("social.view");
  const sp = await searchParams;
  const [accounts, jar] = await Promise.all([listAccounts(ctx), cookies()]);
  const notice = decodeSocialNotice(jar.get(SOCIAL_NOTICE_COOKIE)?.value);
  let choose: { stateId: string; choices: Awaited<ReturnType<typeof pendingChoices>>["choices"] } | null = null;
  let expired = false;
  const stateId = one(sp.choose);
  if (stateId && ctx.can("social.connect")) {
    try {
      choose = { stateId, choices: (await pendingChoices(ctx, stateId)).choices };
    } catch (e) {
      if (e instanceof AppError) expired = true;
      else throw e;
    }
  }
  const skipped = one(sp.skipped);
  return (
    <div className="space-y-5">
      <header>
        <h1 className="flex items-center gap-2 text-[22px] font-semibold tracking-tight text-ink"><PlugZap className="size-5 text-muted" aria-hidden />Accounts</h1>
        <p className="mt-1 max-w-2xl text-[13.5px] text-muted">The Facebook Pages and Instagram accounts posts can go to. They belong to your business: only you can connect or disconnect them, and you can remove iAcquire&apos;s access at any time.</p>
      </header>
      {notice && <p role="status" className={`rounded-2xl px-4 py-3 text-[13.5px] ${notice.kind === "error" ? "bg-danger-soft text-danger-ink" : notice.kind === "success" ? "bg-success-soft text-success-ink" : "bg-surface-2 text-ink-2"}`}>{notice.message}</p>}
      {expired && <p role="status" className="rounded-2xl bg-warning-soft px-4 py-3 text-[13.5px] text-warning-ink">That connection expired. Start it again.</p>}
      {skipped && <p role="status" className="rounded-2xl bg-warning-soft px-4 py-3 text-[13.5px] text-warning-ink">Not connected: {skipped}</p>}
      <AccountsPanel
        accounts={accounts} canConnect={ctx.can("social.connect")} metaReady={metaConfigured()} liveEnabled={livePublishingEnabled()} tz={ctx.org.timezone || "UTC"}
        choose={choose} testAccounts={simulatedAllowed()}
      />
    </div>
  );
}
