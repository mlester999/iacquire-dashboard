import type { Metadata } from "next";
import { headers } from "next/headers";
import { CheckCircle2 } from "lucide-react";
import { allowHostedFormView, hostedFormAfter } from "@/server/crm/forms/public";
import { BusyNotice, FormShell } from "../../../_components/shell";

export const dynamic = "force-dynamic";

type Params = Promise<{ org: string; key: string }>;

export const metadata: Metadata = { title: "Thank you" };

/**
 * Where a form page sends people after they press send without script. With script the form shows its thank-you in place, or goes to
 * the business's chosen page directly. A form that is no longer available still says thank you, without any details.
 */
export default async function HostedFormSentPage({ params }: { params: Params }) {
  const h = await headers();
  if (!(await allowHostedFormView(h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || null))) return <BusyNotice />;
  const { org, key } = await params;
  const after = await hostedFormAfter(org, key);
  return (
    <FormShell business={after?.business ?? null}>
      {/* A form that sends people on refreshes there after a moment, so it works without script too (the link below is always shown). */}
      {after?.redirect && <meta httpEquiv="refresh" content={`3;url=${after.redirect}`} />}
      <div className="mx-auto max-w-lg rounded-3xl border border-line bg-surface p-6 text-center shadow-card sm:p-10">
        <div className="mx-auto flex size-12 items-center justify-center rounded-2xl bg-success-soft text-success-ink">
          <CheckCircle2 className="size-6" aria-hidden />
        </div>
        <h1 className="mt-4 text-[22px] font-semibold tracking-[-0.03em] text-ink">Thank you</h1>
        <p className="mt-2 whitespace-pre-line text-[14.5px] leading-relaxed text-muted">{after?.message || "Your answers have been sent."}</p>
        {after?.redirect && (
          <p className="mt-5">
            <a href={after.redirect} rel="noopener" className="inline-flex min-h-11 items-center justify-center rounded-xl bg-ink px-5 text-[14px] font-semibold text-surface shadow-soft hover:bg-ink/90">
              Continue
            </a>
          </p>
        )}
      </div>
    </FormShell>
  );
}
