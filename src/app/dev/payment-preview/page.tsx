import Link from "next/link";
import { notFound } from "next/navigation";
import { env } from "@/server/env";
import { PreviewTheme } from "@/components/projects/preview-theme";
import { PaymentResultView, type ResultStage } from "@/components/purchase-intents/payment-result";
import { checkoutReturnStage, checkoutReturnText } from "@/lib/purchase-intents/rules";

export const dynamic = "force-dynamic";

// Development-only sample data for the page a buyer lands on after the payment provider's page (/purchase/return/<checkout reference>), so each state can be seen and measured in a
// browser without a payment. The words come from the same function the real page uses; nothing here reads a database or calls anything. Hidden outside development.
//
//   state=waiting|left|test|paid|ready|review|failed|limited
const STATES = ["waiting", "left", "test", "paid", "ready", "review", "failed", "limited"] as const;
type State = (typeof STATES)[number];

function sample(state: State): { stage: ResultStage; title: string; body: string; live: boolean } {
  switch (state) {
    case "waiting": return { stage: checkoutReturnStage("pending", "started"), ...checkoutReturnText("pending", "started"), live: true };
    case "left": return { stage: checkoutReturnStage("pending", "started", true), ...checkoutReturnText("pending", "started", true), live: false };
    case "test": return { stage: checkoutReturnStage("paid", "payment_verified", false, true), ...checkoutReturnText("paid", "payment_verified", false, true), live: false };
    case "paid": return { stage: checkoutReturnStage("paid", "payment_verified"), ...checkoutReturnText("paid", "payment_verified"), live: false };
    case "ready": return { stage: checkoutReturnStage("paid", "provisioned"), ...checkoutReturnText("paid", "provisioned"), live: false };
    case "review": return { stage: checkoutReturnStage("refunded", "payment_verified"), ...checkoutReturnText("refunded", "payment_verified"), live: false };
    case "failed": return { stage: checkoutReturnStage("failed", "started"), ...checkoutReturnText("failed", "started"), live: false };
    case "limited": return { stage: "limited", title: "Too many attempts", body: "Wait a moment and refresh this page.", live: false };
  }
}

export default async function PaymentPreview({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (env().NODE_ENV === "production") notFound();
  const q = await searchParams;
  const raw = typeof q.state === "string" ? q.state : "waiting";
  const state = (STATES as readonly string[]).includes(raw) ? (raw as State) : "waiting";
  const view = sample(state);
  return (
    <>
      <nav aria-label="Samples" className="flex flex-wrap items-center gap-2 border-b border-line bg-surface px-4 py-2 text-[12px]">
        <PreviewTheme />
        {STATES.map((s) => <Link key={s} href={`/dev/payment-preview?state=${s}`} className="rounded-lg border border-line px-2.5 py-1 text-ink-2 hover:bg-surface-2">{s}</Link>)}
      </nav>
      <PaymentResultView stage={view.stage} title={view.title} body={view.body} reference={state === "limited" ? null : "IAQ-SAMPLE0123456"} live={view.live} />
    </>
  );
}
