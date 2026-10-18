import Link from "next/link";

/**
 * The note on the Setup Center right after the client's company information is approved (/setup?onboarded=1). What the iAcquire team does
 * next depends on who runs the CRM: for iAcquire's own CRM (native or hybrid) it applies the industry Blueprint; for a GoHighLevel client it
 * links the sub-account. People who can open the CRM get a link to their CRM setup guide.
 */
export function OnboardedBanner({ nativeCrm, crmGuide }: { nativeCrm: boolean; crmGuide: boolean }) {
  return (
    <div role="status" className="mx-auto mb-4 max-w-6xl rounded-2xl border border-success/30 bg-success-soft/60 p-4 text-[14px] leading-relaxed text-success-ink">
      <strong className="font-semibold">Your company setup is approved.</strong> Your six AI employees have configurations ready.{" "}
      {nativeCrm
        ? "The iAcquire team now applies your industry Blueprint to your CRM and verifies each connection."
        : "The iAcquire team now links your CRM and verifies each connection."}{" "}
      Nothing contacts your customers until you switch it on.
      {crmGuide && (
        <>
          {" "}
          <Link href="/crm/setup" className="font-medium underline underline-offset-2 hover:no-underline">
            Open your CRM setup guide
          </Link>
        </>
      )}
    </div>
  );
}
