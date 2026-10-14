"use client";

import * as React from "react";
import { CheckCircle2, KeyRound, RefreshCw, ShieldCheck, XCircle } from "lucide-react";
import { Field, Input, Select } from "@/components/ui/primitives";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/overlays";
import { LLM_PRESETS, type IntegrationView, type LlmApiFormat } from "@/lib/integrations";

interface TestResult {
  status: string;
  detail: string;
  capabilities?:Record<string,unknown>;
}

const text = (v: unknown) => (typeof v === "string" ? v : "");

/** Agency-wide AI model connection: pick a provider, set base URL / model / key, then run a live check. */
export function LlmConnectionDialog({
  connection,
  storeReady,
  onSave,
  onTest,
  onListModels,
  onClose,
}: {
  connection: IntegrationView;
  storeReady: boolean;
  onSave: (input: unknown) => Promise<void>;
  onTest: () => Promise<TestResult>;
  onListModels: (input: { baseUrl: string; apiFormat: LlmApiFormat; secret?: string }) => Promise<string[]>;
  onClose: () => void;
}) {
  const cfg = connection.config;
  const savedPreset = LLM_PRESETS.find((p) => p.id === text(cfg.llmPreset));
  const [presetId, setPresetId] = React.useState(savedPreset?.id ?? "deepseek");
  const [baseUrl, setBaseUrl] = React.useState(text(cfg.baseUrl) || savedPreset?.baseUrl || LLM_PRESETS[0].baseUrl);
  const [model, setModel] = React.useState(text(cfg.model) || savedPreset?.model || LLM_PRESETS[0].model);
  const [format, setFormat] = React.useState<LlmApiFormat>(cfg.apiFormat === "anthropic" ? "anthropic" : (savedPreset?.format ?? "openai"));
  const [key, setKey] = React.useState("");
  const [busy, setBusy] = React.useState<"save" | "test" | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<TestResult | null>(null);
  const [models, setModels] = React.useState<string[] | null>(null);
  const [manual, setManual] = React.useState(false);
  const [loadingModels, setLoadingModels] = React.useState(false);
  const [modelsError, setModelsError] = React.useState<string | null>(null);

  const preset = LLM_PRESETS.find((p) => p.id === presetId) ?? LLM_PRESETS[0];
  const custom = preset.id === "custom";
  const keyRequired = !connection.hasCredential;
  const keyOk = key.trim().length === 0 ? !keyRequired : key.trim().length >= 16;
  const valid = baseUrl.trim().length > 0 && model.trim().length > 0 && keyOk && storeReady;

  function choose(id: string) {
    const next = LLM_PRESETS.find((p) => p.id === id);
    if (!next) return;
    setPresetId(id);
    setFormat(next.format);
    if (next.baseUrl) setBaseUrl(next.baseUrl);
    else if (LLM_PRESETS.some((p) => p.baseUrl && p.baseUrl === baseUrl)) setBaseUrl("");
    if (next.model) setModel(next.model);
    else if (LLM_PRESETS.some((p) => p.model && p.model === model)) setModel("");
    setResult(null);
    setError(null);
    resetModels();
  }

  function resetModels() {
    setModels(null);
    setManual(false);
    setModelsError(null);
  }

  async function loadModels() {
    setLoadingModels(true);
    setModelsError(null);
    try {
      const list = await onListModels({ baseUrl: baseUrl.trim(), apiFormat: format, ...(key.trim() ? { secret: key.trim() } : {}) });
      setModels(list);
      setManual(false);
      if (!list.includes(model)) setModel(list.includes(preset.model) ? preset.model : list[0]);
    } catch (e) {
      setModelsError(e instanceof Error ? e.message : "Could not load models.");
    } finally {
      setLoadingModels(false);
    }
  }

  const canLoadModels = baseUrl.trim().length > 0 && (key.trim().length >= 16 || connection.hasCredential);

  async function run(test: boolean) {
    setBusy("save");
    setError(null);
    setResult(null);
    try {
      await onSave({
        provider: "llm",
        label: `LLM · ${preset.label}`,
        environment: "production",
        ...(key.trim() ? { secret: key.trim() } : {}),
        config: { baseUrl: baseUrl.trim(), model: model.trim(), apiFormat: format, llmPreset: preset.id },
      });
      setKey("");
      if (test) {
        setBusy("test");
        setResult(await onTest());
      } else onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the connection.");
    } finally {
      setBusy(null);
    }
  }

  const ok = result?.status === "connected";
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
      title="Connect an AI model"
      description="Used by the in-portal help assistant. The key is stored in Supabase Vault and is never shown again."
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={!!busy}>
            {result ? "Close" : "Cancel"}
          </Button>
          <Button variant="secondary" loading={busy === "save"} disabled={!valid || !!busy} onClick={() => void run(false)}>
            Save
          </Button>
          <Button loading={busy === "test"} disabled={!valid || !!busy} onClick={() => void run(true)}>
            <KeyRound className="size-4" /> Save &amp; test connection
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="rounded-xl bg-surface-2 p-3 text-xs leading-relaxed text-muted">
          The test first reads the provider&apos;s model list. If the provider explicitly reports that listing is unsupported (HTTP 404, 405 or 501), it sends a minimal completion request with one output token. That response test may use billable provider credits. Network, authorization and server failures stop the test.
        </p>
        {!storeReady && (
          <p className="rounded-xl bg-warning-soft p-3 text-xs leading-relaxed text-warning-ink" role="status">
            Enable Supabase Vault before saving an API key.
          </p>
        )}
        <Field label="Provider" htmlFor="llm-preset" hint={preset.note}>
          <Select id="llm-preset" value={presetId} onChange={(e) => choose(e.target.value)}>
            {LLM_PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Base URL" htmlFor="llm-base-url" hint={format === "anthropic" ? "Without /v1. Requests go to /v1/messages." : "Requests go to {base URL}/chat/completions."}>
          <Input id="llm-base-url" type="url" inputMode="url" autoComplete="off" spellCheck={false} placeholder="https://api.example.com/v1" value={baseUrl} onChange={(e) => { setBaseUrl(e.target.value); resetModels(); }} />
        </Field>
        {custom && (
          <Field label="API format" htmlFor="llm-format">
            <Select id="llm-format" value={format} onChange={(e) => { setFormat(e.target.value as LlmApiFormat); resetModels(); }}>
              <option value="openai">OpenAI-compatible (Bearer key, /chat/completions)</option>
              <option value="anthropic">Anthropic Messages (x-api-key, /v1/messages)</option>
            </Select>
          </Field>
        )}
        <Field
          label="Model"
          htmlFor="llm-model"
          error={modelsError}
          hint={models && !manual ? `${models.length} models available from ${preset.label}.` : "Load the provider's models, or type an exact model ID. The test confirms it exists."}
        >
          <div className="flex gap-2">
            {models && !manual ? (
              <Select id="llm-model" className="min-w-0 flex-1" value={model} onChange={(e) => setModel(e.target.value)}>
                {!models.includes(model) && model && <option value={model}>{model}</option>}
                {models.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </Select>
            ) : (
              <Input id="llm-model" className="min-w-0 flex-1" autoComplete="off" spellCheck={false} placeholder="deepseek-chat" value={model} onChange={(e) => setModel(e.target.value)} />
            )}
            <Button variant="secondary" loading={loadingModels} disabled={!canLoadModels || loadingModels || !!busy} onClick={() => void loadModels()}>
              {!loadingModels && <RefreshCw className="size-4" />} {models ? "Reload" : "Load models"}
            </Button>
          </div>
          {models && (
            <button type="button" className="text-[12.5px] text-primary hover:underline" onClick={() => setManual((v) => !v)}>
              {manual ? "Choose from the list" : "Type a model ID instead"}
            </button>
          )}
        </Field>
        <Field
          label="API key"
          htmlFor="llm-key"
          optional={!keyRequired}
          hint={connection.hasCredential ? `Leave blank to keep the saved key${connection.fingerprint ? ` (fingerprint ${connection.fingerprint})` : ""}.` : "Paste the key from your provider dashboard."}
        >
          <Input id="llm-key" type="password" autoComplete="off" spellCheck={false} placeholder={connection.hasCredential ? "••••••••••••••••" : "sk-…"} value={key} onChange={(e) => { setKey(e.target.value); if (models) resetModels(); }} />
        </Field>
        {custom && (
          <p className="flex items-start gap-2 text-xs leading-relaxed text-muted">
            <ShieldCheck className="mt-0.5 size-3.5 shrink-0" /> Custom hosts must be listed in INTEGRATION_ALLOWED_HOSTS in your server settings. This stops the key being sent to arbitrary servers.
          </p>
        )}
        {error && (
          <p className="rounded-xl bg-danger-soft p-3 text-xs leading-relaxed text-danger-ink" role="alert">
            {error}
          </p>
        )}
        {result && (
          <p className={`flex items-start gap-2 rounded-xl p-3 text-xs leading-relaxed ${ok ? "bg-success-soft text-success-ink" : "bg-warning-soft text-warning-ink"}`} role="status">
            {ok ? <CheckCircle2 className="mt-0.5 size-4 shrink-0" /> : <XCircle className="mt-0.5 size-4 shrink-0" />}
            <span>{result.capabilities?.verificationOperation==="basic_model_response" && <strong className="mb-1 block">Minimal model response test</strong>}{result.detail}</span>
          </p>
        )}
      </div>
    </Dialog>
  );
}
