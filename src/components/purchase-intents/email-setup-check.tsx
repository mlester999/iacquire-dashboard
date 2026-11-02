"use client";

import * as React from "react";
import { CheckCircle2, Loader2, ShieldCheck, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { checkEmailSetupAction } from "@/app/actions/purchase-intents";
import type { EmailSetupCheck } from "@/server/purchase-intents/email-check";

// "Check email setup", beside the invitation's email box. Whether the sender's domain is verified is the email provider's to say, so the server asks it (read-only, with iAcquire's own key,
// sending nothing) and this draws its answer item by item. Nothing here holds or shows a key, and a failed or refused check is shown as a failure, never as ready.
export function EmailSetupChecker({ initial = null }: { initial?: EmailSetupCheck | null }) {
  const [checking, setChecking] = React.useState(false);
  const [result, setResult] = React.useState<EmailSetupCheck | null>(initial);
  const [error, setError] = React.useState<string | null>(null);

  async function run() {
    setChecking(true);
    setError(null);
    try {
      const res = await checkEmailSetupAction();
      if (!res.ok) setError(res.error);
      else setResult(res.data);
    } catch {
      setError("The check could not be run. Try again.");
    } finally {
      setChecking(false);
    }
  }

  return (
    <div className="mt-2 pl-6 text-[12.5px] leading-relaxed">
      <Button type="button" variant="secondary" size="sm" onClick={() => void run()} loading={checking} disabled={checking}>
        {checking ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <ShieldCheck className="size-3.5" aria-hidden />} Check email setup
      </Button>
      <p className="mt-1 text-muted">Asks the email provider whether the sender&apos;s domain is verified and whether its delivery notices reach this site. Nothing is sent.</p>
      <div role="status" aria-live="polite">
        {error && <p role="alert" className="mt-2 rounded-lg border border-danger/30 bg-danger-soft px-3 py-2 text-danger-ink">{error}</p>}
        {result && (
          <div className="mt-2 rounded-xl border border-line bg-surface px-3 py-2.5 text-ink">
            <p className="font-medium">{result.headline}</p>
            <ul className="mt-1.5 space-y-1.5">
              {result.checks.map((c) => (
                <li key={`${c.label}:${c.detail}`} className="flex items-start gap-2">
                  {c.ok ? <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-success" aria-hidden /> : <XCircle className="mt-0.5 size-3.5 shrink-0 text-danger" aria-hidden />}
                  <span>
                    <strong className="font-semibold">{c.label}</strong>
                    <span className="sr-only">{c.ok ? ": passed." : ": not passed."}</span>
                    {" "}
                    <span className="text-ink-2 [overflow-wrap:anywhere]">{c.detail}</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
