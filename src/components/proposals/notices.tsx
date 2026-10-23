import Link from "next/link";
import { FileText } from "lucide-react";

/** The heading, and the first sentence of the refusal the server gives for the same reason (PROPOSALS_NOT_ENABLED_MESSAGE in src/server/proposals/features.ts). */
export const PROPOSALS_NOT_ENABLED_TITLE = "Proposals aren't switched on for your workspace yet";

/** What the proposals area shows in a workspace a Super Admin has not switched it on for. Nothing here queries or changes anything. */
export function ProposalsNotEnabled({ isOwner }: { isOwner: boolean }) {
  return (
    <section aria-labelledby="proposals-off" className="space-y-3 rounded-2xl border border-line bg-surface p-5">
      <h1 id="proposals-off" className="flex items-center gap-2 text-[20px] font-semibold tracking-tight text-ink"><FileText className="size-5 text-muted" aria-hidden />{PROPOSALS_NOT_ENABLED_TITLE}</h1>
      <p className="max-w-2xl text-[13.5px] text-ink-2">Proposals let your team write, get approved and send proposals to customers, and keep what each customer answered. iAcquire switches the feature on for a workspace when it is ready for it.</p>
      <p className="max-w-2xl text-[13.5px] text-ink-2">{isOwner ? "Ask your iAcquire contact to switch it on for your workspace." : "Ask your workspace owner to ask iAcquire to switch it on."}</p>
      <Link href="/overview" className="inline-flex min-h-11 items-center rounded-xl border border-line bg-surface px-4 text-[13.5px] font-medium text-ink hover:bg-surface-2 sm:min-h-10">Back to the overview</Link>
    </section>
  );
}

/** What the proposals area shows in an agency workspace: proposals belong to the client business that sends them. */
export function ProposalsClientOnly({ canOpenClients }: { canOpenClients: boolean }) {
  return (
    <section aria-labelledby="proposals-client-only" className="space-y-3 rounded-2xl border border-line bg-surface p-5">
      <h1 id="proposals-client-only" className="flex items-center gap-2 text-[20px] font-semibold tracking-tight text-ink"><FileText className="size-5 text-muted" aria-hidden />Proposals are managed inside each client&apos;s workspace</h1>
      <p className="max-w-2xl text-[13.5px] text-ink-2">A proposal is the client business&apos;s own offer to its own customer, and that business&apos;s team approves and sends it. An agency workspace has no proposals of its own. iAcquire staff can help set up a client&apos;s price book and templates from the client&apos;s workspace, in an audited support session.</p>
      {canOpenClients && <Link href="/admin/clients" className="inline-flex min-h-11 items-center rounded-xl brand-gradient px-4 text-[13.5px] font-medium text-white sm:min-h-10">Go to clients</Link>}
    </section>
  );
}
