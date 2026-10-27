/** Shared layout for the signed-out screens. */

import type { ReactNode } from 'react';

import { Card } from '../components/ui';
import { ThemeToggle } from '../components/ThemeToggle';

export function AuthLayout({
  title,
  description,
  children,
  footer,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-surface-sunken px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-sm bg-ink text-white shadow-[3px_3px_0_var(--color-brand-500)]">
              <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" aria-hidden="true"><path d="M5 7h8a3 3 0 0 1 3 3v1M19 17h-8a3 3 0 0 1-3-3v-1M13 5l3 3-3 3M11 13l-3 3 3 3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
            </span>
            <span className="text-base font-bold tracking-tight text-ink">SyncFix</span>
          </div>
          <ThemeToggle />
        </div>
        <Card>
          <div className="px-5 py-5">
            <h1 className="text-lg">{title}</h1>
            {description ? <p className="mt-1 text-[13px] text-ink-muted">{description}</p> : null}
            <div className="mt-4">{children}</div>
          </div>
        </Card>
        {footer ? <div className="mt-4 text-center text-[13px] text-ink-muted">{footer}</div> : null}
        <p className="mt-6 text-center text-xs text-ink-subtle">
          SyncFix reconciles CRM, billing and support records. It never overwrites a destination field without a mapped rule.
        </p>
      </div>
    </div>
  );
}

export function FormError({ message }: { message?: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" className="rounded-lg border border-danger/30 bg-danger-soft px-3 py-2 text-[13px] text-[color:var(--color-danger)]">
      {message}
    </p>
  );
}