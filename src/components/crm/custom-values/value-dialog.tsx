"use client";

import * as React from "react";
import { Info, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/primitives";
import { Dialog, Switch } from "@/components/ui/overlays";
import { createCustomValueAction, updateCustomValueAction } from "@/app/actions/crm-custom-values";
import { useCrmAction } from "@/components/crm/ui";
import {
  checkGroup, checkKey, checkLabel, CUSTOM_VALUE_LIMITS, CUSTOM_VALUE_TYPE_HINTS, CUSTOM_VALUE_TYPE_LABELS, CUSTOM_VALUE_TYPES, keyFromLabel, normalizeCustomValue, type CustomValueType,
} from "@/lib/crm/custom-values";
import { customValueTokenKey, tokenText } from "@/lib/messaging/tokens";
import type { CustomValueView } from "@/server/crm/custom-values";
import type { CrmScope } from "@/server/crm/page";

const INPUT_MODE: Partial<Record<CustomValueType, React.HTMLAttributes<HTMLInputElement>["inputMode"]>> = { url: "url", phone: "tel", email: "email", number: "decimal" };
const PLACEHOLDER: Record<CustomValueType, string> = {
  text: "123 Example Street, Makati",
  url: "https://www.yourbusiness.com/book",
  phone: "+63 917 123 4567",
  email: "hello@yourbusiness.com",
  number: "15",
  color: "#1f6feb",
};

/**
 * Adds or edits a configuration value. Every rule the server applies (type, length, no credentials) is checked here as the person types,
 * so mistakes show before saving; the server checks again. The key is fixed once created, because templates refer to it.
 */
export function CustomValueDialog({ scope, value, groups, defaultCallingCode, onClose }: {
  scope: CrmScope;
  value: CustomValueView | null;
  groups: string[];
  defaultCallingCode: string | null;
  onClose: () => void;
}) {
  const { run, busy } = useCrmAction();
  const editing = Boolean(value);
  const [label, setLabel] = React.useState(value?.label ?? "");
  const [key, setKey] = React.useState(value?.key ?? "");
  const [keyTouched, setKeyTouched] = React.useState(false);
  const [type, setType] = React.useState<CustomValueType>(value?.type ?? "text");
  const [raw, setRaw] = React.useState(value?.value ?? "");
  const [group, setGroup] = React.useState(value?.group ?? "");
  const [required, setRequired] = React.useState(value?.required ?? false);
  const [touched, setTouched] = React.useState<Record<string, boolean>>({});
  const [attempted, setAttempted] = React.useState(false);
  const show = (f: string) => attempted || touched[f];
  const touch = (f: string) => () => setTouched((t) => ({ ...t, [f]: true }));

  // A new value's key follows its name until the person edits the key themselves.
  const effectiveKey = editing ? value!.key : keyTouched ? key : label.trim() ? keyFromLabel(label) : "";
  const labelCheck = checkLabel(label);
  const keyCheck = editing ? ({ ok: true, key: effectiveKey } as const) : checkKey(effectiveKey);
  const groupCheck = checkGroup(group);
  const valueCheck = normalizeCustomValue(type, raw, { defaultCallingCode });
  const valid = labelCheck.ok && keyCheck.ok && groupCheck.ok && valueCheck.ok;
  const normalized = valueCheck.ok ? valueCheck.value : null;
  const emptyRequired = required && valueCheck.ok && !valueCheck.value;
  const approvedUses = (value?.usage ?? []).filter((u) => u.blocking).length;
  const valueChanged = editing && normalized !== null && normalized !== value!.value;

  async function save() {
    setAttempted(true);
    if (!valid) return;
    const input = { label: labelCheck.ok ? labelCheck.label : label, type, value: raw, group: group.trim() || null, required };
    const ok = value
      ? await run("save", () => updateCustomValueAction(scope.orgId, value.id, { ...input, expectedUpdatedAt: value.updatedAt }), "Value saved.")
      : await run("save", () => createCustomValueAction(scope.orgId, { ...input, key: effectiveKey }), "Value added.");
    if (ok) onClose();
  }

  const valueField = (
    <Field
      label="Value"
      htmlFor="cv-value"
      optional={!required}
      error={show("value") && !valueCheck.ok ? valueCheck.error : null}
      hint={
        normalized && normalized !== raw.trim()
          ? <>Saved as <span className="font-mono text-ink-2">{normalized}</span>. {CUSTOM_VALUE_TYPE_HINTS[type]}</>
          : CUSTOM_VALUE_TYPE_HINTS[type]
      }
      className="sm:col-span-2"
    >
      {type === "text" ? (
        <Textarea
          id="cv-value"
          rows={3}
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          onBlur={touch("value")}
          maxLength={CUSTOM_VALUE_LIMITS.value}
          placeholder={PLACEHOLDER.text}
          aria-invalid={(show("value") && !valueCheck.ok) || undefined}
        />
      ) : (
        <div className="flex items-center gap-2">
          {type === "color" && (
            <input
              type="color"
              aria-label="Pick a colour"
              className="h-11 w-12 shrink-0 cursor-pointer rounded-xl border border-line-strong bg-surface p-1 sm:h-10"
              value={/^#[0-9a-f]{6}$/i.test(normalized ?? "") ? normalized! : "#000000"}
              onChange={(e) => setRaw(e.target.value)}
            />
          )}
          <Input
            id="cv-value"
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
            onBlur={touch("value")}
            inputMode={INPUT_MODE[type]}
            autoComplete="off"
            spellCheck={false}
            maxLength={CUSTOM_VALUE_LIMITS.value}
            placeholder={PLACEHOLDER[type]}
            aria-invalid={(show("value") && !valueCheck.ok) || undefined}
          />
        </div>
      )}
    </Field>
  );

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={value ? `Edit ${value.label}` : "New configuration value"}
      description={value ? undefined : "Something your messages repeat, stated once. Never a password, key or token: those belong in Integrations."}
      size="md"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button loading={busy("save")} onClick={save} disabled={attempted && !valid}>{value ? "Save" : "Add value"}</Button>
        </>
      }
    >
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
        className="grid gap-3 sm:grid-cols-2"
      >
        <Field label="Name" htmlFor="cv-label" error={show("label") && !labelCheck.ok ? labelCheck.error : null} className="sm:col-span-2">
          <Input id="cv-label" value={label} onChange={(e) => setLabel(e.target.value)} onBlur={touch("label")} maxLength={CUSTOM_VALUE_LIMITS.label} placeholder="Booking link" autoFocus aria-invalid={(show("label") && !labelCheck.ok) || undefined} />
        </Field>

        {editing ? (
          <div className="space-y-1.5 sm:col-span-2">
            <p className="text-[14px] font-medium text-ink-2">Token</p>
            <p className="flex flex-wrap items-center gap-2 text-[14px]">
              <code className="break-all rounded bg-surface-2 px-1.5 py-0.5 text-[12px] text-ink-2">{value!.token}</code>
              <span className="inline-flex items-center gap-1 text-[13px] text-muted"><Lock className="size-3" aria-hidden />The key can&apos;t change: templates refer to it.</span>
            </p>
          </div>
        ) : (
          <Field
            label="Key"
            htmlFor="cv-key"
            className="sm:col-span-2"
            error={(show("key") || keyTouched) && !keyCheck.ok ? keyCheck.error : null}
            hint={keyCheck.ok && effectiveKey ? <>Templates use <code className="break-all rounded bg-surface-2 px-1 py-0.5 text-[12px]">{tokenText(customValueTokenKey(effectiveKey))}</code>. The key can&apos;t be changed later.</> : "Made from the name. Lower-case letters, numbers and _ only."}
          >
            <Input
              id="cv-key"
              value={effectiveKey}
              onChange={(e) => {
                setKeyTouched(true);
                setKey(e.target.value.toLowerCase().replace(/[\s-]+/g, "_"));
              }}
              onBlur={touch("key")}
              maxLength={CUSTOM_VALUE_LIMITS.key}
              autoComplete="off"
              spellCheck={false}
              className="font-mono"
              placeholder="booking_link"
              aria-invalid={((show("key") || keyTouched) && !keyCheck.ok) || undefined}
            />
          </Field>
        )}

        <Field label="Type" htmlFor="cv-type">
          <Select id="cv-type" value={type} onChange={(e) => setType(e.target.value as CustomValueType)}>
            {CUSTOM_VALUE_TYPES.map((t) => <option key={t} value={t}>{CUSTOM_VALUE_TYPE_LABELS[t]}</option>)}
          </Select>
        </Field>
        <Field label="Group" htmlFor="cv-group" optional error={!groupCheck.ok ? groupCheck.error : null} hint="Keeps related values together, such as Location or Offers.">
          <Input id="cv-group" value={group} onChange={(e) => setGroup(e.target.value)} maxLength={CUSTOM_VALUE_LIMITS.group} list="cv-groups" placeholder="Location" autoComplete="off" />
          <datalist id="cv-groups">{groups.map((g) => <option key={g} value={g} />)}</datalist>
        </Field>

        {valueField}

        <div className="flex items-start gap-3 sm:col-span-2">
          <Switch id="cv-required" checked={required} onCheckedChange={setRequired} aria-describedby="cv-required-hint" />
          <div>
            <label htmlFor="cv-required" className="text-[14px] font-medium text-ink-2">Required</label>
            <p id="cv-required-hint" className="text-[13px] leading-relaxed text-muted">
              Messages that use a required value are held, not sent, while it is empty. An optional value that is empty simply shows nothing.
            </p>
          </div>
        </div>

        {(emptyRequired || (valueChanged && approvedUses > 0)) && (
          <div role="status" className="flex items-start gap-2 rounded-xl border border-line bg-surface-2/70 px-3 py-2 text-[13px] leading-relaxed text-ink-2 sm:col-span-2">
            <Info className="mt-0.5 size-3.5 shrink-0 text-muted" aria-hidden />
            <span>
              {emptyRequired && "This value is required but empty, so messages that use it will be held until someone fills it in. "}
              {valueChanged && approvedUses > 0 && `${approvedUses === 1 ? "An approved template or active campaign uses" : `${approvedUses} approved templates or active campaigns use`} this value: messages sent after you save will use the new value.`}
            </span>
          </div>
        )}
        {/* Enter in a single-line field saves, like any form. */}
        <button type="submit" className="hidden" tabIndex={-1} aria-hidden />
      </form>
    </Dialog>
  );
}
