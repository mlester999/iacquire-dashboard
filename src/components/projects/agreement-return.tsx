"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { completeAgreementReturnAction } from "@/app/actions/projects";

// The owner is back from PayPal's page. Approving there asks PayPal to collect; it pays for nothing by itself. Once, on arrival, this asks the server to read PayPal's own record of the
// agreement (and anything it already collected) and to apply it. It sends only the agreement's reference, never decides anything, and never says a payment was received: the page
// reads the stored state afterwards.
export function AgreementReturn({ reference }: { reference: string }) {
  const router = useRouter();
  const started = React.useRef(false);
  React.useEffect(() => {
    if (started.current) return;
    started.current = true;
    void completeAgreementReturnAction(reference).then(() => router.refresh()).catch(() => router.refresh());
  }, [reference, router]);
  return null;
}
