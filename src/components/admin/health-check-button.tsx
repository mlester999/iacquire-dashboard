"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Stethoscope } from "lucide-react";
import { Button } from "@/components/ui/button";
import { healthCheckAction } from "@/app/(admin)/admin/actions";

export function HealthCheckButton({ agentId }: { agentId: string }) {
  const router = useRouter();
  const [pending, setPending] = React.useState(false);
  return (
    <Button
      size="sm"
      variant="secondary"
      loading={pending}
      onClick={async () => {
        setPending(true);
        const res = await healthCheckAction(agentId);
        setPending(false);
        if (!res.ok) return toast.error(res.error);
        toast[res.data.ok ? "success" : "warning"](res.data.ok ? "Online" : res.data.detail);
        router.refresh();
      }}
    >
      <Stethoscope className="size-3.5" aria-hidden /> Run health check
    </Button>
  );
}
