import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';

import type { ApiFailure } from '../host/api';

/** Shared presentation primitives (10B.UI). Module pages compose these
 * instead of inline styles, so spacing and states stay consistent. */

export function Page({
  title,
  subtitle,
  actions,
  children,
}: {
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="ui-page">
      <header className="ui-page__header">
        <div>
          <h2 className="ui-page__title">{title}</h2>
          {subtitle ? <p className="ui-page__subtitle">{subtitle}</p> : null}
        </div>
        {actions ? <div className="ui-page__actions">{actions}</div> : null}
      </header>
      {children}
    </section>
  );
}

export function Card({
  title,
  actions,
  children,
  className,
}: {
  title?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={className ? `ui-card ${className}` : 'ui-card'}>
      {(title || actions) && (
        <header className="ui-card__header">
          {title ? <h3 className="ui-card__title">{title}</h3> : null}
          {actions ? <div className="ui-card__actions">{actions}</div> : null}
        </header>
      )}
      {children}
    </section>
  );
}

export function Notice({
  tone = 'info',
  children,
  onDismiss,
}: {
  tone?: 'info' | 'success' | 'warning' | 'error';
  children: ReactNode;
  onDismiss?: () => void;
}) {
  return (
    <div className={`ui-notice ui-notice--${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      <div className="ui-notice__body">{children}</div>
      {onDismiss ? (
        <button
          type="button"
          className="ui-notice__dismiss"
          onClick={onDismiss}
          aria-label="Dismiss"
        >
          ×
        </button>
      ) : null}
    </div>
  );
}

export function ErrorNotice({
  error,
  onRetry,
  onDismiss,
}: {
  error: ApiFailure | Error | string | null;
  onRetry?: () => void;
  onDismiss?: () => void;
}) {
  const key = error
    ? typeof error === 'string'
      ? error
      : error instanceof Error
        ? error.message
        : `${error.envelope.code}:${error.envelope.correlationId}`
    : null;
  const [dismissed, setDismissed] = useState<string | null>(null);

  useEffect(() => {
    if (!error) setDismissed(null);
  }, [error]);

  if (!error || (key !== null && key === dismissed)) return null;
  const envelope =
    typeof error === 'string' || error instanceof Error ? null : (error as ApiFailure).envelope;
  const message =
    typeof error === 'string'
      ? error
      : error instanceof Error
        ? error.message
        : (error as ApiFailure).envelope.userMessage;
  return (
    <Notice
      tone="error"
      onDismiss={() => {
        if (key !== null) setDismissed(key);
        onDismiss?.();
      }}
    >
      <strong>{message}</strong>
      {envelope ? (
        <span className="ui-notice__meta">
          {envelope.code} · ref {envelope.correlationId}
          {envelope.retryAfterMs
            ? ` · retry in ${Math.max(1, Math.round(envelope.retryAfterMs / 1000))}s`
            : ''}
        </span>
      ) : null}
      {onRetry ? (
        <button type="button" className="ui-button ui-button--ghost" onClick={onRetry}>
          Retry
        </button>
      ) : null}
    </Notice>
  );
}

export function Button({
  children,
  variant = 'default',
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'default' | 'primary' | 'ghost' | 'danger';
}) {
  return (
    <button
      {...props}
      className={['ui-button', `ui-button--${variant}`, className].filter(Boolean).join(' ')}
    >
      {children}
    </button>
  );
}

export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <label className="ui-field">
      <span className="ui-field__label">{label}</span>
      {children}
      {hint ? <span className="ui-field__hint">{hint}</span> : null}
    </label>
  );
}

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={['ui-input', props.className].filter(Boolean).join(' ')} />;
}

export function Textarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea {...props} className={['ui-input', props.className].filter(Boolean).join(' ')} />
  );
}

export function Table({ children }: { children: ReactNode }) {
  return (
    <div className="ui-table-wrap">
      <table className="ui-table">{children}</table>
    </div>
  );
}

export function StatusText({ status, color }: { status: string; color?: string }) {
  return (
    <strong className="ui-status" style={color ? { color } : undefined}>
      {status}
    </strong>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <p className="ui-empty">{children}</p>;
}

export function Loading({ children = 'Loading…' }: { children?: ReactNode }) {
  return (
    <p className="ui-loading" role="status">
      {children}
    </p>
  );
}

/** Only http(s) links are rendered as anchors (R18); everything else is text. */
export function safeExternalUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}
