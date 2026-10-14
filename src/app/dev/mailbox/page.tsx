import { notFound } from "next/navigation";
import { withSystem } from "@/server/db";
import { env } from "@/server/env";
import { Logo } from "@/components/brand";

export const dynamic = "force-dynamic";
export const metadata = { title: "Dev mailbox" };

/** Development only: shows emails captured by EMAIL_PROVIDER=capture. Returns 404 in production. */
export default async function DevMailbox() {
  if (env().NODE_ENV === "production" || env().EMAIL_PROVIDER !== "capture") notFound();
  const { rows } = await withSystem((db) =>
    db.query<{ id: string; to_email: string; subject: string; body_text: string; template: string; created_at: Date }>(
      "select id, to_email, subject, body_text, template, created_at from email_outbox order by created_at desc limit 50",
    ),
  );
  const linkify = (text: string) =>
    text.split(/(https?:\/\/[^\s]+)/g).map((part, i) =>
      /^https?:\/\//.test(part) ? (
        <a key={i} href={part} className="break-all text-primary underline">
          {part}
        </a>
      ) : (
        <span key={i}>{part}</span>
      ),
    );
  return (
    <main className="mx-auto max-w-3xl px-4 py-10">
      <Logo />
      <h1 className="mt-6 text-[24px] font-semibold">Development mailbox</h1>
      <p className="mt-1 text-[14px] text-muted">Emails captured locally (not delivered). Only available in development.</p>
      <ul className="mt-6 space-y-4">
        {rows.map((m) => (
          <li key={m.id} className="card-surface rounded-2xl p-5">
            <p className="text-[12px] text-muted">
              To {m.to_email} · {m.template} · {new Date(m.created_at).toLocaleString()}
            </p>
            <p className="mt-1 text-[15px] font-semibold">{m.subject}</p>
            <p className="mt-2 whitespace-pre-wrap text-[13.5px] leading-relaxed">{linkify(m.body_text)}</p>
          </li>
        ))}
        {rows.length === 0 && <li className="text-[14px] text-muted">No emails yet.</li>}
      </ul>
    </main>
  );
}
