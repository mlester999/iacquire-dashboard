"use client";

import * as React from "react";
import { CircleAlert, CreditCard, Printer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { BACK_STORAGE_KEY, PAY_ENDPOINT, TOKEN_HEADER, type PayResponse } from "@/lib/invoices/public-http";
import { money } from "@/lib/invoices/labels";
import type { CurrencyCode } from "@/lib/money";

// The customer's two buttons. Paying asks the server for the provider's own payment page and then goes there: the amount is never sent, only the link (in a header). The
// customer's card details are entered on the provider's page, never here. Printing uses the browser's own print, which drops everything but the invoice.

function remember() {
  try {
    window.sessionStorage.setItem(BACK_STORAGE_KEY, window.location.pathname);
  } catch {
    // Storage can be blocked; the return page then simply has no way back to offer.
  }
}

/** Where the browser goes. A seam so the page's behaviour can be tested without a real navigation. */
const goTo = (url: string) => window.location.assign(url);

export function PayPanel({ token, canPay, balanceMinor, currency, isTest = false, navigate = goTo }: { token: string; canPay: boolean; balanceMinor: number; currency: CurrencyCode; isTest?: boolean; navigate?: (url: string) => void }) {
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function pay() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(PAY_ENDPOINT, { method: "POST", headers: { [TOKEN_HEADER]: token }, cache: "no-store", referrerPolicy: "no-referrer" });
      const body = (await res.json().catch(() => ({}))) as PayResponse;
      if (res.ok && body.url) {
        remember();
        // Navigation, not a form post: the site's policy lets forms post to this site only.
        navigate(body.url);
        return;
      }
      setError(body.message ?? "The payment page could not be opened just now. Nothing was charged. Please try again in a few minutes.");
    } catch {
      setError("The payment page could not be opened just now. Nothing was charged. Check your connection and try again.");
    }
    setBusy(false);
  }

  return (
    <section aria-label="Pay or print" className="mt-5 space-y-3 print:hidden">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        {canPay && (
          <Button variant="brand" size="lg" className="w-full sm:w-auto" loading={busy} onClick={pay}>
            <CreditCard className="size-4" aria-hidden />
            {busy ? "Opening the payment page" : isTest ? `Pay ${money(balanceMinor, currency)} as a test` : `Pay ${money(balanceMinor, currency)} online`}
          </Button>
        )}
        <Button variant="secondary" size="lg" className="w-full sm:w-auto" onClick={() => window.print()}>
          <Printer className="size-4" aria-hidden />
          Print or save as PDF
        </Button>
      </div>
      {canPay && !isTest && <p className="text-[12.5px] leading-relaxed text-muted">You will be taken to your payment provider&apos;s own page to pay. Your card details are entered there, not on this page.</p>}
      {canPay && isTest && <p className="text-[12.5px] leading-relaxed text-muted">This is a test invoice. You will be taken to a testing page; no card is asked for and no money moves.</p>}
      <noscript><p className="text-[12.5px] text-muted">Paying online needs JavaScript. You can still pay using the instructions on the invoice.</p></noscript>
      {error && (
        <p role="alert" className="flex items-start gap-2 rounded-xl border border-danger/20 bg-danger-soft px-4 py-3 text-[13.5px] text-danger-ink">
          <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>{error}</span>
        </p>
      )}
    </section>
  );
}
