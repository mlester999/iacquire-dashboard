"use client";

import { useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { checkWorkspaceOAuthAction, disconnectWorkspaceOAuthAction, startWorkspaceOAuthAction } from "@/app/actions/workspace-oauth";
import { WORKSPACE_OAUTH_LABEL, type WorkspaceConnectionView } from "@/lib/integrations/workspace-oauth";

export function WorkspaceOAuthControls({ orgId, connection }: { orgId: string; connection: WorkspaceConnectionView }) {
  const [pending, startTransition] = useTransition();
  const { provider, configured, status } = connection;
  const name = WORKSPACE_OAUTH_LABEL[provider];
  const hasConnection = status !== "disconnected";
  const canCheck = configured && hasConnection && status !== "needs_reauth";

  return (
    <div className="flex flex-wrap items-center gap-2">
      {configured && <Button size="sm" variant="secondary" disabled={pending} aria-label={`${hasConnection ? "Reconnect" : "Connect"} ${name}`} onClick={() => startTransition(async () => {
        const result = await startWorkspaceOAuthAction(orgId, provider);
        if (result.ok) window.location.assign(result.data);
        else toast.error(result.error);
      })}>{hasConnection ? "Reconnect" : "Connect"}</Button>}
      {canCheck && <Button size="sm" variant="secondary" disabled={pending} aria-label={`Verify ${name} connection`} onClick={() => startTransition(async () => {
        const result = await checkWorkspaceOAuthAction(orgId, provider);
        if (!result.ok) toast.error(result.error);
        else if (result.data.status === "connected") toast.success(`${name} authorization verified.`);
        else if (result.data.status === "needs_reauth") toast.error(`Reconnect ${name} to restore authorization.`);
        else toast.error(`${name} could not be verified. Try again later.`);
      })}>Verify connection</Button>}
      {hasConnection && <Button size="sm" variant="ghost" disabled={pending} aria-label={`Disconnect ${name}`} onClick={() => {
        if (!window.confirm(`Disconnect ${name} from this workspace?`)) return;
        startTransition(async () => {
          const result = await disconnectWorkspaceOAuthAction(orgId, provider);
          if (!result.ok) toast.error(result.error);
          else if (result.data === "revoked") toast.success("Disconnected. Notion confirmed the access token was revoked.");
          else toast.success(`Disconnected from iAcquire. To revoke the grant, remove iAcquire in ${name} settings.`, { duration: 12_000 });
        });
      }}>Disconnect</Button>}
    </div>
  );
}
