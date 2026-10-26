"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

// While the payment provider's confirmation has not arrived, the return page reads the stored status again every few seconds, for a couple of minutes, so a buyer who just paid sees
// "Payment confirmed" without reloading. It only re-reads: the page never decides that a payment happened, and nothing is sent from here.
export function ReturnRefresh({ active }: { active: boolean }) {
  const router = useRouter();
  React.useEffect(() => {
    if (!active) return;
    let tries = 0;
    const id = window.setInterval(() => {
      tries += 1;
      if (tries > 24) window.clearInterval(id);
      else router.refresh();
    }, 5000);
    return () => window.clearInterval(id);
  }, [active, router]);
  return null;
}
