"use client";

import { useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { requestGrowthPartnerAbilityRestorationAction, restrictGrowthPartnerAbilitiesAction } from "@/app/actions/ai-growth-partner";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardContent, CardHeader, CardTitle } from "@/components/ui/primitives";
import { agentToolLabel } from "@/lib/agent-tools";
import type { GrowthPartnerAbilityControls } from "@/server/ai-growth-partner/ability-controls";

export function GrowthPartnerAbilityEditor({ controls }: { controls: GrowthPartnerAbilityControls }) {
  const router = useRouter();
  const [selection, setSelection] = useState<{ versionId: string; keys: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshing, startRefresh] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const versionId = "versionId" in controls ? controls.versionId : null;
  const selected = selection && selection.versionId === versionId ? selection.keys : [];
  const canSave = controls.state === "ready" && !refreshing;
  const setupNote = controls.state === "setup_required"
    ? "Restrictions become available when your Growth Partner has its first applied configuration."
    : controls.state === "review_pending"
      ? "Resolve the open configuration review before making another change."
      : null;

  async function submit(change: "restrict" | "restore", keys: string[]) {
    if (!canSave || !versionId || !keys.length || busy) return;
    const restoring = change === "restore";
    setBusy(true);
    setNotice(null);
    setError(null);
    try {
      const result = restoring
        ? await requestGrowthPartnerAbilityRestorationAction({ expectedVersionId: versionId, restore: keys })
        : await restrictGrowthPartnerAbilitiesAction({ expectedVersionId: versionId, restrict: keys });
      if (!result.ok) {
        setError(result.error);
        if (result.code === "conflict") startRefresh(() => router.refresh());
        return;
      }
      setSelection(null);
      setNotice(result.data.status === "review_pending"
        ? restoring
          ? `Restoration requested in configuration v${result.data.version}. Access changes after agency approval.`
          : `Configuration v${result.data.version} is waiting for review before these restrictions apply.`
        : result.data.status === "applied"
          ? `Restrictions saved in configuration v${result.data.version}.`
          : restoring ? "That action is already available." : "Those actions are already restricted.");
      startRefresh(() => router.refresh());
    } catch {
      setError(restoring ? "Restoration could not be requested. Try again." : "Restrictions could not be saved. Try again.");
    } finally {
      setBusy(false);
    }
  }

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void submit("restrict", selected);
  }

  return (
    <Card className="mb-4">
      <CardHeader>
        <div>
          <CardTitle>Restricted capabilities</CardTitle>
          <p className="mt-1 text-[13px] leading-relaxed text-muted">
            Switch off individual actions or request review to restore them. Workspace permissions and approval rules apply to every action.
          </p>
        </div>
        {"version" in controls && <Badge tone="neutral">Applied v{controls.version}</Badge>}
      </CardHeader>
      <CardContent>
        {setupNote && <p className="mb-3 text-[13px] text-muted">{setupNote}</p>}
        {"abilities" in controls && (
          <form onSubmit={save}>
            {controls.abilities.length ? (
              <fieldset disabled={!canSave || busy} className="grid gap-2 sm:grid-cols-2">
                <legend className="sr-only">Growth Partner actions to switch off</legend>
                {controls.abilities.map(({ key, restricted }) => {
                  const label = key === "research.public_web" ? "Request research from approved public sources" : agentToolLabel(key);
                  return (
                    <div key={key} className="flex min-h-11 min-w-0 flex-wrap items-center gap-x-2.5 rounded-lg border border-line bg-surface-2/40 px-3 py-2 text-[13px] text-ink">
                      <label className="flex min-w-0 flex-1 items-center gap-2.5">
                        <input
                          type="checkbox"
                          checked={restricted || selected.includes(key)}
                          disabled={restricted}
                          onChange={(event) => {
                            setSelection({ versionId: controls.versionId, keys: event.target.checked ? [...selected, key] : selected.filter((item) => item !== key) });
                            setNotice(null);
                            setError(null);
                          }}
                          className="size-4 shrink-0 accent-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                        />
                        <span>{label}</span>
                        {restricted && <Badge tone="neutral">Restricted</Badge>}
                      </label>
                      {restricted && controls.state === "ready" && (
                        <Button type="button" variant="ghost" size="sm" aria-label={`Request restoration for ${label}`} onClick={() => void submit("restore", [key])}>
                          Request restoration
                        </Button>
                      )}
                    </div>
                  );
                })}
              </fieldset>
            ) : <p className="text-[13px] text-muted">There are no reviewed actions available to restrict.</p>}
            {controls.abilities.some((item) => !item.restricted) && controls.state === "ready" && (
              <Button type="submit" variant="secondary" loading={busy} disabled={!canSave || !selected.length} className="mt-3">
                Save restrictions
              </Button>
            )}
          </form>
        )}
        {error && <p role="alert" className="mt-3 text-[13px] text-red-ink">{error}</p>}
        {notice && <p role="status" className="mt-3 text-[13px] text-muted">{notice}</p>}
      </CardContent>
    </Card>
  );
}
