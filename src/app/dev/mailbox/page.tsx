import { notFound } from "next/navigation";
import { withSystem } from "@/server/db";
import { env } from "@/server/env";
import { Logo } from "@/components/brand";
import { renderEmail } from "@/server/email-render";
import type { EmailTemplate } from "@/server/email";

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
      <p className="mt-1 text-[14px] text-muted">Emails captured locally (not delivered), shown as recipients get them. Presentation hints such as severity colour and category are not stored in the outbox, so previews show the neutral variant. Only available in development.</p>
      {rows.length === 0 && <p className="mt-6 text-[14px] text-muted">No emails yet.</p>}
      <ul className="mt-6 space-y-6">
        {rows.map((m) => {
          const rendered = renderEmail({ to: m.to_email, template: m.template as EmailTemplate, subject: m.subject, text: m.body_text }, { baseUrl: env().APP_URL, images: "always" });
          return (
            <li key={m.id} className="card-surface overflow-hidden rounded-2xl">
              <div className="border-b border-line px-5 py-3">
                <p className="text-[12px] text-muted">
                  To {m.to_email} · {m.template} · {new Date(m.created_at).toLocaleString()}
                </p>
                <p className="mt-1 text-[15px] font-semibold">{m.subject}</p>
              </div>
              {/* No allow-scripts and no allow-same-origin, ever: captured bodies are untrusted. Popups are allowed so links can be tested. */}
              <iframe title={m.subject} srcDoc={rendered.html} sandbox="allow-popups allow-popups-to-escape-sandbox" loading="lazy" className="block h-[720px] w-full border-0 bg-white" />
              <details className="border-t border-line px-5 py-3 text-[14px]">
                <summary className="cursor-pointer text-muted">Plain-text version</summary>
                <p className="mt-2 whitespace-pre-wrap leading-relaxed">{linkify(m.body_text)}</p>
              </details>
            </li>
          );
        })}
      </ul>
    </main>
  );
}
