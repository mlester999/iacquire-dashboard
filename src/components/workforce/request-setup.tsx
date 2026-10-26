"use client";

import * as React from "react";
import { toast } from "sonner";
import { Wrench } from "lucide-react";
import { Button } from "@/components/ui/button";
import { requestSetupAction } from "@/app/actions/workforce";
import { PAYMENT_REQUIRED_SENTENCE } from "@/lib/billing-clearance";

export function RequestSetupButton({ count }: { count: number }) {
  const [pending, setPending] = React.useState(false);
  return (
    <Button
      variant="secondary"
      loading={pending}
      onClick={async () => {
        setPending(true);
        const res = await requestSetupAction();
        setPending(false);
        if (!res.ok) return toast.error(res.error);
        // Nothing was opened and the payment is not confirmed: say that, never "already in progress".
        if (!res.data.requested && !res.data.paymentCleared) return toast.info(PAYMENT_REQUIRED_SENTENCE + ".");
        toast.success(res.data.requested ? "iAcquire has been asked to finish setting up your employees." : `Setup for ${count} employee${count === 1 ? " is" : "s are"} already in progress with iAcquire.`);
      }}
    >
      <Wrench className="size-4" /> Check setup status
    </Button>
  );
}
