import * as React from "react";
import { Gauge, Lock, MessageSquareHeart, Reply, ThumbsUp, UserRound } from "lucide-react";
import { Badge, Card, EmptyState } from "@/components/ui/primitives";
import { answersIn, formatHours, MIN_ACKNOWLEDGED_SAMPLE, type ResponseShare, type SatisfactionReport, type ScoreBlock, type Segment } from "@/lib/reputation/satisfaction";
import { MIN_RESPONSES, tooFewText, type CsatSummary, type NpsSummary } from "@/lib/reputation/scores";

// CRM → Reviews → Satisfaction. Private feedback only: nothing here is a public review. A score is shown only when there are enough answers behind it; below that the screen
// says how many answers there are and how many are needed, never a number that looks like a result.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "Week of 12 Oct" from the week's first day (YYYY-MM-DD). */
const weekLabel = (week: string) => {
  const [, m, d] = week.split("-").map(Number);
  return m >= 1 && m <= 12 ? `Week of ${d} ${MONTHS[m - 1]}` : week;
};
const signed = (n: number) => (n > 0 ? `+${n}` : String(n));

function Tile({ icon: Icon, label, value, detail }: { icon: typeof Gauge; label: string; value: React.ReactNode; detail: React.ReactNode }) {
  return (
    <div className="min-w-0 rounded-2xl border border-line bg-surface p-4">
      <p className="flex items-center gap-2 text-[12.5px] font-medium text-muted"><Icon className="size-4 shrink-0" aria-hidden />{label}</p>
      <p className="mt-2 text-[26px] font-semibold leading-none tracking-[-0.03em] text-ink tabular-nums">{value}</p>
      <p className="mt-2 text-[12px] leading-relaxed text-muted">{detail}</p>
    </div>
  );
}

/** "82% were satisfied" or "7 answers so far: too few for a score." */
export function csatText(c: CsatSummary): string {
  return c.percent === null ? tooFewText(c.answers, c.needed) : `${c.percent}% rated 4 or 5, from ${c.answers} answers. Average ${c.average} of 5.`;
}

export function npsText(n: NpsSummary): string {
  return n.score === null ? tooFewText(n.answers, n.needed) : `${n.promoters} promoters, ${n.passives} passives, ${n.detractors} detractors, from ${n.answers} answers.`;
}

function share(s: ResponseShare): string {
  if (s.sent === 0) return "none sent";
  return `${s.answered} of ${s.sent} answered${s.percent === null ? "" : ` (${s.percent}%)`}`;
}

function Scores({ block }: { block: ScoreBlock }) {
  return (
    <>
      {block.csat.answers > 0 && <span>{block.csat.percent === null ? `1 to 5: ${tooFewText(block.csat.answers, block.csat.needed)}` : `1 to 5: ${block.csat.percent}% rated 4 or 5`}</span>}
      {block.nps.answers > 0 && <span>{block.nps.score === null ? `0 to 10: ${tooFewText(block.nps.answers, block.nps.needed)}` : `0 to 10: score ${signed(block.nps.score)}`}</span>}
    </>
  );
}

function SegmentList({ title, segments, empty }: { title: string; segments: Segment[]; empty: string }) {
  return (
    <Card className="p-4 sm:p-5">
      <h3 className="text-[14.5px] font-semibold text-ink">{title}</h3>
      {segments.length === 0 ? (
        <p className="mt-2 text-[13px] text-muted">{empty}</p>
      ) : (
        <ul className="mt-3 space-y-2" aria-label={title}>
          {segments.map((s) => (
            <li key={s.id} className="rounded-xl bg-surface-2/70 px-3 py-2">
              <p className="text-[13.5px] font-medium text-ink">{s.name}</p>
              <p className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[12.5px] text-muted"><span>{s.answers} {s.answers === 1 ? "answer" : "answers"}</span><Scores block={s.block} /></p>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export function SatisfactionPanel({ report }: { report: SatisfactionReport }) {
  const r = report;
  const total = answersIn(r.named);
  const period = r.days === 365 ? "12 months" : `${r.days} days`;
  return (
    <section aria-label="Satisfaction" className="space-y-5">
      <p className="flex items-start gap-2 text-[12.5px] leading-relaxed text-muted">
        <Lock className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        <span>
          Private feedback from your customers over the last {period}. It is never published and is not a public review. A score appears only after {MIN_RESPONSES.csat5} answers on the 1 to 5 scale, or {MIN_RESPONSES.nps10} on the 0 to 10 scale.
        </span>
      </p>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Tile icon={ThumbsUp} label="Satisfied (1 to 5)" value={r.named.csat.percent === null ? "–" : `${r.named.csat.percent}%`} detail={csatText(r.named.csat)} />
        <Tile icon={Gauge} label="Recommend score (0 to 10)" value={r.named.nps.score === null ? "–" : signed(r.named.nps.score)} detail={npsText(r.named.nps)} />
        <Tile icon={MessageSquareHeart} label="Answers" value={total} detail="From a customer's own link, or a survey that knew who answered." />
        <Tile
          icon={Reply}
          label="Got an answer"
          value={r.response.review.sent + r.response.survey.sent === 0 ? "–" : r.response.review.answered + r.response.survey.answered}
          detail={<>Review requests: {share(r.response.review)}. Surveys: {share(r.response.survey)}.</>}
        />
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card className="p-4 sm:p-5">
          <h3 className="text-[14.5px] font-semibold text-ink">Week by week</h3>
          {r.trend.length === 0 ? (
            <EmptyState compact icon={<MessageSquareHeart className="size-5" />} title="No answers in this period" description="When customers answer, the weeks appear here." />
          ) : (
            <ul className="mt-3 space-y-2" aria-label="Answers by week">
              {r.trend.map((t) => (
                <li key={t.week} className="rounded-xl bg-surface-2/70 px-3 py-2">
                  <p className="text-[13.5px] font-medium text-ink">{weekLabel(t.week)}</p>
                  <p className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[12.5px] text-muted"><span>{t.answers} {t.answers === 1 ? "answer" : "answers"}</span><Scores block={t.block} /></p>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card className="p-4 sm:p-5">
          <h3 className="text-[14.5px] font-semibold text-ink">Following up on low feedback</h3>
          <dl className="mt-3 grid grid-cols-2 gap-3 text-[13px]">
            <div><dt className="text-muted">Waiting for a follow-up now</dt><dd className="mt-0.5 text-[20px] font-semibold tabular-nums text-ink">{r.followUp.open}</dd></div>
            <div><dt className="text-muted">Past {r.followUp.acknowledgeWithinHours} {r.followUp.acknowledgeWithinHours === 1 ? "hour" : "hours"} unacknowledged</dt><dd className="mt-0.5 text-[20px] font-semibold tabular-nums text-ink">{r.followUp.overdue}</dd></div>
          </dl>
          <p className="mt-3 text-[12.5px] leading-relaxed text-muted">
            {r.followUp.medianHoursToAcknowledge === null
              ? `Time to acknowledge: ${r.followUp.acknowledged} acknowledged so far in this period. A typical time appears after ${MIN_ACKNOWLEDGED_SAMPLE}.`
              : `Typical time to acknowledge: ${formatHours(r.followUp.medianHoursToAcknowledge)} (from ${r.followUp.acknowledged} acknowledged in this period).`}
          </p>
        </Card>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <SegmentList title="By appointment type" segments={r.byAppointmentType} empty="Answers tied to an attended appointment appear here by type." />
        <SegmentList title="By calendar" segments={r.byCalendar} empty="Answers tied to an attended appointment appear here by calendar." />
      </div>

      <Card className="p-4 sm:p-5">
        <h3 className="flex items-center gap-2 text-[14.5px] font-semibold text-ink"><UserRound className="size-4 text-muted" aria-hidden />Anonymous survey answers <Badge tone="outline">Not in the numbers above</Badge></h3>
        <p className="mt-2 text-[13px] leading-relaxed text-muted">
          {answersIn(r.anonymous) === 0
            ? "No answers from surveys that didn't ask who was answering."
            : `${answersIn(r.anonymous)} ${answersIn(r.anonymous) === 1 ? "answer" : "answers"} from surveys that didn't know who answered. `}
          {r.anonymous.csat.answers > 0 && <>{" "}1 to 5: {csatText(r.anonymous.csat)}</>}
          {r.anonymous.nps.answers > 0 && <>{" "}0 to 10: {npsText(r.anonymous.nps)}</>}
        </p>
      </Card>

      <p className="text-[12px] leading-relaxed text-muted">
        The recommend score uses the standard groups: 9 or 10 are promoters, 7 or 8 passives, 0 to 6 detractors. {r.handRecorded > 0 ? `${r.handRecorded} ${r.handRecorded === 1 ? "piece of feedback was" : "pieces of feedback were"} recorded by hand or imported in this period. They are kept with the private feedback but not scored here, because they aren't a customer's own answer.` : ""}
      </p>
    </section>
  );
}
