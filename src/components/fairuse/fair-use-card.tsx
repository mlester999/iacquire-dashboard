import { Server } from "lucide-react";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, ProgressBar } from "@/components/ui/primitives";
import { STATE_LABEL } from "@/lib/fair-use";
import type { FairUseRow } from "@/server/fairuse/service";

const TONE = { unset: "neutral", ok: "success", warning: "warning", over: "danger" } as const;

/**
 * What the workspace actually uses of the shared hosting, and the allowance if the agency has set one. With no allowance set it says so plainly:
 * "no monthly platform fee" does not mean unlimited forever, but nothing is limited until real provider costs have been measured.
 */
export function FairUseCard({ rows }: { rows: FairUseRow[] }) {
  if (!rows.length) return null;
  return (
    <Card>
      <CardHeader>
        <div className="flex items-start gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary-soft text-primary-ink"><Server className="size-4" aria-hidden /></span>
          <div>
            <CardTitle>Hosting and storage</CardTitle>
            <CardDescription>iAcquire hosts your website, files and conversations on shared infrastructure with no monthly platform fee. These are real measurements of what you use. Fair-use allowances are set from measured provider costs, never invented, and we tell you before anything changes.</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        {rows.map((r) => (
          <div key={r.metric}>
            <div className="mb-1.5 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <p className="text-[14px] font-medium">{r.label} <span className="text-[12px] font-normal text-muted">· {r.window}</span></p>
              <p className="flex items-center gap-2 text-[13px] tabular-nums text-ink-2">
                {r.valueText}{r.limitText ? ` of ${r.limitText}` : ""}
                <Badge tone={TONE[r.state]}>{STATE_LABEL[r.state]}</Badge>
              </p>
            </div>
            {r.limit !== null && r.limit > 0 && <ProgressBar value={Math.min(100, (r.value / r.limit) * 100)} tone={r.state === "over" ? "danger" : r.state === "warning" ? "warning" : "primary"} label={`${r.label} used`} />}
            <p className="mt-1 text-[12px] leading-relaxed text-muted">{r.explain}{r.state === "unset" ? " No allowance has been set for your workspace yet." : ""}{r.enforcement === "block_new" && r.limit !== null ? " If this fills up, new uploads pause. Nothing you already have is removed." : ""}</p>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
