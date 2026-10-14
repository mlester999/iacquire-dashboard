"use client";

import * as React from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { createTicketAction } from "@/app/actions/support";

export function RequestConnection({ what }: { what: string }) {
  const [state, setState] = React.useState<"idle" | "pending" | "done">("idle");
  return (
    <Button
      size="sm"
      variant="secondary"
      disabled={state !== "idle"}
      loading={state === "pending"}
      onClick={async () => {
        setState("pending");
        const res = await createTicketAction({ subject: `Connection request: ${what}`, message: `Please help us connect ${what} to our iAcquire workspace.`, category: "integrations", pageContext: "/settings/integrations" });
        if (!res.ok) {
          setState("idle");
          return toast.error(res.error);
        }
        setState("done");
        toast.success(`Request ${res.data.ref} sent to the iAcquire team`);
      }}
    >
      {state === "done" ? "Requested" : "Request"}
    </Button>
  );
}
