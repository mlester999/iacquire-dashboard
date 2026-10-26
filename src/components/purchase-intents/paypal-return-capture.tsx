"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { completePaypalReturnAction } from "@/app/actions/purchase-intents";

// The buyer is back from PayPal's page. Approving there does not take the money, so once, on arrival, this asks the server to take the payment the buyer approved and to record what
// PayPal itself reports. It sends only the checkout's reference; it never decides anything and never says a payment was received: the page re-reads the stored state afterwards.
export function PaypalReturnCapture({ reference }: { reference: string }) {
  const router = useRouter();
  const started = React.useRef(false);
  React.useEffect(() => {
    if (started.current) return;
    started.current = true;
    void completePaypalReturnAction(reference).then(() => router.refresh()).catch(() => router.refresh());
  }, [reference, router]);
  return null;
}
