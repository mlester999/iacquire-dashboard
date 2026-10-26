"use client";

import * as React from "react";
import { ExternalLink, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/primitives";
import { Dialog } from "@/components/ui/overlays";
import { useCrmAction } from "@/components/crm/ui";
import { connectCalDavAction, connectIcsFeedAction } from "@/app/actions/crm-calendar-connections";
import type { CrmScope } from "@/server/crm/page";

/**
 * iCloud and other CalDAV servers: an address (preset for iCloud), a username and an app-specific password. The server is found and a
 * read is made before anything is saved; the password is sent once, stored encrypted, and cleared from this form either way.
 */
export function CalDavDialog({ scope, preset, open, onOpenChange, initialLabel }: { scope: CrmScope; preset: "icloud" | "caldav"; open: boolean; onOpenChange: (o: boolean) => void; initialLabel?: string | null }) {
  const { run, busy } = useCrmAction();
  const id = React.useId();
  const [serverUrl, setServerUrl] = React.useState("");
  const [username, setUsername] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [label, setLabel] = React.useState(initialLabel ?? "");
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [wasOpen, setWasOpen] = React.useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setServerUrl("");
      setUsername("");
      setPassword("");
      setLabel(initialLabel ?? "");
      setErrors({});
    }
  }
  const icloud = preset === "icloud";

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const next: Record<string, string> = {};
    if (!icloud) {
      try {
        if (new URL(serverUrl.trim()).protocol !== "https:") next.serverUrl = "Use the server's https:// address.";
      } catch {
        next.serverUrl = "Enter the server's address, starting with https://.";
      }
    }
    if (!username.trim()) next.username = icloud ? "Enter your Apple ID email." : "Enter your username.";
    if (!password.trim()) next.password = icloud ? "Enter an app-specific password." : "Enter your password.";
    setErrors(next);
    if (Object.keys(next).length) return;
    const res = await run("caldav", () => connectCalDavAction(scope.orgId, { preset, serverUrl: icloud ? null : serverUrl.trim(), username: username.trim(), password, label: label.trim() || null }), (r) => `${icloud ? "iCloud" : "Calendar"} connected: ${r.calendars} ${r.calendars === 1 ? "calendar" : "calendars"} found.`);
    setPassword("");
    if (res) onOpenChange(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={icloud ? "Connect Apple iCloud" : "Connect a CalDAV calendar"}
      description={icloud ? "iCloud calendars connect with an app-specific password, never your Apple ID password." : "For Fastmail, Nextcloud, Synology, Radicale and other servers that speak CalDAV over HTTPS."}
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="submit" form={`${id}-form`} loading={busy("caldav")}>Test and connect</Button>
        </>
      }
    >
      <form id={`${id}-form`} className="space-y-4" onSubmit={submit} noValidate>
        {icloud && (
          <div className="rounded-xl border border-line bg-surface-2 px-3.5 py-3 text-[13px] leading-relaxed text-ink-2">
            <p className="font-medium text-ink">Create an app-specific password first</p>
            <ol className="mt-1 list-decimal space-y-0.5 pl-4">
              <li>Sign in at account.apple.com (two-factor authentication must be on).</li>
              <li>Open Sign-In and Security, then App-Specific Passwords, and create one named &ldquo;iAcquire&rdquo;.</li>
              <li>Paste it below. You can revoke it there at any time.</li>
            </ol>
            <a href="https://account.apple.com/" target="_blank" rel="noreferrer noopener" className="mt-1.5 inline-flex items-center gap-1 font-medium text-primary hover:underline">
              Open account.apple.com<ExternalLink className="size-3" aria-hidden /><span className="sr-only">(opens in a new tab)</span>
            </a>
          </div>
        )}
        {!icloud && (
          <Field label="Server address" htmlFor={`${id}-url`} error={errors.serverUrl} hint="The CalDAV address your provider gives, for example https://caldav.fastmail.com/. iAcquire finds your calendars from there.">
            <Input id={`${id}-url`} inputMode="url" autoComplete="url" placeholder="https://" value={serverUrl} onChange={(e) => setServerUrl(e.target.value)} aria-invalid={!!errors.serverUrl} />
          </Field>
        )}
        <Field label={icloud ? "Apple ID email" : "Username"} htmlFor={`${id}-user`} error={errors.username}>
          <Input id={`${id}-user`} autoComplete="username" inputMode={icloud ? "email" : undefined} value={username} onChange={(e) => setUsername(e.target.value)} aria-invalid={!!errors.username} />
        </Field>
        <Field label={icloud ? "App-specific password" : "Password or app password"} htmlFor={`${id}-pass`} error={errors.password} hint={<span className="inline-flex items-center gap-1"><Lock className="size-3" aria-hidden />Stored encrypted. Nobody, including iAcquire staff, can view it after you save.</span>}>
          <Input id={`${id}-pass`} type="password" autoComplete="off" spellCheck={false} value={password} onChange={(e) => setPassword(e.target.value)} aria-invalid={!!errors.password} />
        </Field>
        <Field label="Name in iAcquire" htmlFor={`${id}-label`} optional hint="Shown on this page. Defaults to the username.">
          <Input id={`${id}-label`} maxLength={200} value={label} onChange={(e) => setLabel(e.target.value)} />
        </Field>
      </form>
    </Dialog>
  );
}

/** A read-only ICS feed: the address is fetched and read once before it's saved, and stored encrypted (it is often a private link). */
export function IcsDialog({ scope, open, onOpenChange, minutes, initialLabel }: { scope: CrmScope; open: boolean; onOpenChange: (o: boolean) => void; minutes: number; initialLabel?: string | null }) {
  const { run, busy } = useCrmAction();
  const id = React.useId();
  const [url, setUrl] = React.useState("");
  const [label, setLabel] = React.useState(initialLabel ?? "");
  const [error, setError] = React.useState<string | null>(null);
  const [wasOpen, setWasOpen] = React.useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setUrl("");
      setLabel(initialLabel ?? "");
      setError(null);
    }
  }
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const v = url.trim();
    if (!/^(https|webcals?):\/\//i.test(v)) {
      setError("Paste the feed's address. It starts with https:// (or webcal://).");
      return;
    }
    setError(null);
    const res = await run("ics", () => connectIcsFeedAction(scope.orgId, { url: v, label: label.trim() || null }), "Feed added. Its busy times now count.");
    if (res) onOpenChange(false);
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Add an ICS feed"
      description={`Read-only: busy times only, and changes show up when the feed is next read (about every ${minutes} minutes), not instantly.`}
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="submit" form={`${id}-form`} loading={busy("ics")}>Test and add</Button>
        </>
      }
    >
      <form id={`${id}-form`} className="space-y-4" onSubmit={submit} noValidate>
        <Field label="Feed address" htmlFor={`${id}-url`} error={error} hint="Most calendars offer one under sharing or export settings (for example Google's “Secret address in iCal format”). Treat it like a password: anyone with it can see the calendar.">
          <Input id={`${id}-url`} inputMode="url" autoComplete="off" spellCheck={false} placeholder="https://" value={url} onChange={(e) => setUrl(e.target.value)} aria-invalid={!!error} />
        </Field>
        <Field label="Name in iAcquire" htmlFor={`${id}-label`} optional hint="Defaults to the calendar's own name.">
          <Input id={`${id}-label`} maxLength={200} value={label} onChange={(e) => setLabel(e.target.value)} />
        </Field>
      </form>
    </Dialog>
  );
}
