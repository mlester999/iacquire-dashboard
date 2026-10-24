import { LifeBuoy, ThumbsUp, TriangleAlert } from "lucide-react";
import { requireOrgContext } from "@/server/tenancy/context";
import { CLIENT_STATUS_FILTERS, countMyRequests, listMyRequests, type ClientStatusFilter } from "@/server/support/service";
import { PageHero } from "@/components/ui/workspace";
import { ButtonLink } from "@/components/ui/button";
import { RequestsList, type ListQuery } from "@/components/support/requests-list";
import { REQUEST_TYPES, type RequestType } from "@/lib/support/lifecycle";

export const metadata = { title: "My Requests" };

type Params = { status?: string; type?: string; q?: string; sort?: string; scope?: string; page?: string };
const SORTS = ["updated", "newest", "oldest", "status"] as const;

/** Reads the address into a query the server will accept; anything unrecognised falls back to the default. */
function parse(p: Params): ListQuery {
  return {
    status: (CLIENT_STATUS_FILTERS as readonly string[]).includes(p.status ?? "") ? (p.status as ClientStatusFilter) : "all",
    requestType: (REQUEST_TYPES as readonly string[]).includes(p.type ?? "") ? (p.type as RequestType) : "",
    q: (p.q ?? "").slice(0, 100).trim(),
    sort: (SORTS as readonly string[]).includes(p.sort ?? "") ? (p.sort as ListQuery["sort"]) : "updated",
    scope: p.scope === "mine" ? "mine" : "all",
    page: Math.max(1, Math.min(500, Number.parseInt(p.page ?? "1", 10) || 1)),
  };
}

export default async function MyRequestsPage({ searchParams }: { searchParams: Promise<Params> }) {
  const ctx = await requireOrgContext("support.use");
  const query = parse(await searchParams);
  const [data, counts] = await Promise.all([
    listMyRequests(ctx, { status: query.status, requestType: query.requestType || undefined, q: query.q, sort: query.sort, scope: query.scope, page: query.page, pageSize: 10 }),
    countMyRequests(ctx, query.scope),
  ]);
  const seesAll = ctx.can("support.view_all");
  return (
    <div className="module-stack">
      <PageHero eyebrow="Requests · My Requests" title="Everything you've sent us, in one place" tone="neutral"
        description={seesAll ? "Support requests, issue reports, feedback and change requests from your workspace, with every reply and its progress." : "Your support requests, issue reports, feedback and change requests, with every reply and its progress."}
        icon={<LifeBuoy className="size-5" />}
        action={<><ButtonLink href="/support" variant="brand"><LifeBuoy className="size-4" aria-hidden /> Get support</ButtonLink><ButtonLink href="/support/report-issue" variant="secondary"><TriangleAlert className="size-4" aria-hidden /> Report an issue</ButtonLink><ButtonLink href="/support/feedback" variant="secondary"><ThumbsUp className="size-4" aria-hidden /> Provide feedback</ButtonLink></>} />
      <RequestsList data={data} counts={counts} query={query} seesAll={seesAll} timeZone={ctx.org.timezone} />
    </div>
  );
}
