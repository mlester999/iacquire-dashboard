import { Database, Globe, HardDrive, MessagesSquare, Radar, Server, Sparkles, type LucideIcon } from "lucide-react";
import { Panel } from "@/components/settings/panel";
import { UsageMeter } from "@/components/settings/usage-meter";
import type { StatusTone } from "@/components/ui/status";
import { STATE_LABEL } from "@/lib/fair-use";
import type { FairUseRow } from "@/server/fairuse/service";

const TONE: Record<FairUseRow["state"], StatusTone> = { unset: "neutral", ok: "success", warning: "warning", over: "danger" };
const ICONS: Record<string, LucideIcon> = {
  storage_bytes: HardDrive,
  site_bandwidth_bytes_30d: Globe,
  site_requests_30d: Database,
  ai_runs_30d: Sparkles,
  research_calls_30d: Radar,
  stored_messages: MessagesSquare,
};

/**
 * What the workspace actually uses of the shared hosting, and the allowance if the agency has set one. With no allowance set it says so plainly:
 * "no monthly platform fee" does not mean unlimited forever, but nothing is limited until real provider costs have been measured.
 */
export function FairUseCard({ rows }: { rows: FairUseRow[] }) {
  if (!rows.length) return null;
  return (
    <Panel
      icon={<Server />}
      title="Hosting and storage"
      description="iAcquire hosts your website, files and conversations on shared infrastructure with no monthly platform fee. These are real measurements of what you use. Fair-use allowances are set from measured provider costs, never invented, and we tell you before anything changes."
    >
      <div className="grid gap-3 md:grid-cols-2">
        {rows.map((r) => {
          const Icon = ICONS[r.metric] ?? Server;
          const percent = r.limit !== null && r.limit > 0 ? Math.min(100, (r.value / r.limit) * 100) : null;
          return (
            <UsageMeter
              key={r.metric}
              icon={<Icon />}
              label={r.label}
              window={r.window === "now" ? "Right now" : r.window.replace(/^last/, "Last")}
              value={r.valueText}
              limit={r.limitText}
              percent={percent}
              tone={TONE[r.state]}
              stateLabel={STATE_LABEL[r.state]}
              hint={`${r.explain}${r.state === "unset" ? " No allowance has been set for your workspace yet." : ""}${r.enforcement === "block_new" && r.limit !== null ? " If this fills up, new uploads pause. Nothing you already have is removed." : ""}`}
            />
          );
        })}
      </div>
    </Panel>
  );
}
