import { PlugZap } from "lucide-react";

/**
 * Shown on the sign-in page when Supabase Auth is selected but the environment is incomplete.
 * It lists variable *names* and what is wrong with them, never values.
 */
export function SupabaseNotConnected({ problems }: { problems: Array<{ code: string; message: string }> }) {
  return (
    <div role="alert" className="rounded-2xl border border-warning/30 bg-warning-soft p-5 text-warning-ink">
      <div className="mb-3 flex items-center gap-2.5">
        <span className="flex size-9 items-center justify-center rounded-xl bg-surface/60">
          <PlugZap className="size-5" />
        </span>
        <h1 className="text-[18px] font-semibold tracking-[-0.01em]">Supabase isn&apos;t connected yet</h1>
      </div>
      <p className="mb-3 text-[14px] leading-relaxed">
        This portal is set to use Supabase Auth, but its configuration is incomplete, so sign-in is paused. Nothing has fallen back to
        the built-in login.
      </p>
      <ul className="mb-3 list-disc space-y-1.5 pl-5 text-[14px] leading-relaxed">
        {problems.map((p) => (
          <li key={p.code + p.message}>{p.message}</li>
        ))}
      </ul>
      <p className="text-[13px] leading-relaxed">
        Add the values to <code className="rounded bg-surface/60 px-1">.env.local</code> and restart the dev server. Step-by-step
        instructions are in <code className="rounded bg-surface/60 px-1">docs/supabase-setup.md</code>. To work without Supabase locally,
        set <code className="rounded bg-surface/60 px-1">AUTH_PROVIDER=local</code>.
      </p>
    </div>
  );
}
