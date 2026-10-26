import Link from "next/link";
import { Receipt } from "lucide-react";

/** The heading, and the first sentence of the refusal the server gives for the same reason (INVOICES_NOT_ENABLED_MESSAGE in src/server/invoices/feature.ts). */
export const INVOICES_NOT_ENABLED_TITLE = "Customer invoices aren't switched on for your workspace yet";

/** What the invoices area shows in a workspace a Super Admin has not switched it on for. Nothing here queries or changes anything. */
export function InvoicesNotEnabled({ isOwner }: { isOwner: boolean }) {
  return (
    <section aria-labelledby="invoices-off" className="space-y-3 rounded-2xl border border-line bg-surface p-5">
      <h1 id="invoices-off" className="flex items-center gap-2 text-[20px] font-semibold tracking-tight text-ink"><Receipt className="size-5 text-muted" aria-hidden />{INVOICES_NOT_ENABLED_TITLE}</h1>
      <p className="max-w-2xl text-[14px] text-ink-2">Invoices let your team bill your own customers, share a payment page with them, and keep a record of what was paid. iAcquire switches the feature on for a workspace when it is ready for it.</p>
      <p className="max-w-2xl text-[14px] text-ink-2">{isOwner ? "Ask your iAcquire contact to switch it on for your workspace." : "Ask your workspace owner to ask iAcquire to switch it on."}</p>
      <Link href="/overview" className="inline-flex min-h-11 items-center rounded-xl border border-line bg-surface px-4 text-[14px] font-medium text-ink hover:bg-surface-2 sm:min-h-10">Back to the overview</Link>
    </section>
  );
}

/** What the invoices area shows in an agency workspace: invoices belong to the client business that sends them. This is not iAcquire's own billing. */
export function InvoicesClientOnly({ canOpenClients }: { canOpenClients: boolean }) {
  return (
    <section aria-labelledby="invoices-client-only" className="space-y-3 rounded-2xl border border-line bg-surface p-5">
      <h1 id="invoices-client-only" className="flex items-center gap-2 text-[20px] font-semibold tracking-tight text-ink"><Receipt className="size-5 text-muted" aria-hidden />Customer invoices live inside each client&apos;s workspace</h1>
      <p className="max-w-2xl text-[14px] text-ink-2">An invoice here is the client business&apos;s own bill to its own customer, and that business&apos;s team writes, approves and sends it. An agency workspace has none of its own. iAcquire&apos;s own billing is under Billing, and is separate.</p>
      {canOpenClients && <Link href="/admin/clients" className="inline-flex min-h-11 items-center rounded-xl brand-gradient px-4 text-[14px] font-medium text-white sm:min-h-10">Go to clients</Link>}
    </section>
  );
}
