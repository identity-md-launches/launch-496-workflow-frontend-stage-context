// Shared presentational components: buttons with their own pending state, labelled fields,
// address display with copy + explorer link, notices and transaction status lines.
import { type ReactNode, useId, useState } from 'react';
import { getAddress } from 'viem';
import { useDeployment } from '../DeploymentContext';
import { explorerAddressUrl, explorerTxUrl, shortAddress, shortHash } from '../lib/format';
import type { TxState } from '../hooks/useTx';

export function Spinner() {
  return <span className="spinner" aria-hidden="true" />;
}

export interface ActionButtonProps {
  children: ReactNode;
  onClick?: () => void;
  /** When set, the button is disabled and the reason renders beside it. */
  disabledReason?: string;
  pending?: boolean;
  pendingLabel?: string;
  variant?: 'primary' | 'secondary';
  block?: boolean;
  type?: 'button' | 'submit';
  small?: boolean;
}

export function ActionButton({ children, onClick, disabledReason, pending, pendingLabel, variant = 'primary', block, type = 'button', small }: ActionButtonProps) {
  const id = useId();
  const disabled = Boolean(disabledReason) || Boolean(pending);
  return (
    <div className="stat" style={{ gap: 6 }}>
      <button
        type={type}
        className={`btn ${variant === 'primary' ? 'primary' : ''} ${block ? 'block' : ''} ${small ? 'small' : ''}`}
        onClick={onClick}
        disabled={disabled}
        aria-describedby={disabledReason ? id : undefined}
        aria-busy={pending || undefined}
      >
        {pending ? <Spinner /> : null}
        {pending ? (pendingLabel ?? children) : children}
      </button>
      {disabledReason ? (
        <p id={id} className="caption">
          {disabledReason}
        </p>
      ) : null}
    </div>
  );
}

export interface FieldProps {
  label: string;
  hint?: string;
  error?: string;
  unit?: string;
  children: (props: { id: string; describedBy: string | undefined; invalid: boolean }) => ReactNode;
}

export function Field({ label, hint, error, unit, children }: FieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ') || undefined;
  const control = children({ id, describedBy, invalid: Boolean(error) });
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {unit ? (
        <div className="input-with-unit">
          {control}
          <span className="unit" aria-hidden="true">
            {unit}
          </span>
        </div>
      ) : (
        control
      )}
      {hint ? (
        <p id={hintId} className="hint">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function CopyIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
      <path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" />
    </svg>
  );
}

function ExternalIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path d="M6.5 3.5h-2a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1v-2" />
      <path d="M9.5 2.5h4v4M13.5 2.5 7.5 8.5" />
    </svg>
  );
}

export function AddressDisplay({ address, label, full }: { address: string; label?: string; full?: boolean }) {
  const dep = useDeployment();
  const [copied, setCopied] = useState(false);
  const checksummed = getAddress(address);
  const url = explorerAddressUrl(dep.network?.explorer, checksummed);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(checksummed);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };
  const name = label ?? 'address';
  return (
    <span className="address">
      <span className="mono" title={checksummed}>
        {full ? checksummed : shortAddress(checksummed)}
      </span>
      <button type="button" className="icon-btn" onClick={copy} aria-label={copied ? `Copied ${name}` : `Copy ${name}`}>
        <CopyIcon />
      </button>
      {url ? (
        <a className="icon-btn" href={url} target="_blank" rel="noreferrer" aria-label={`Open ${name} in the block explorer`}>
          <ExternalIcon />
        </a>
      ) : null}
      <span className="sr-only" role="status">
        {copied ? 'Address copied' : ''}
      </span>
    </span>
  );
}

export function Notice({ kind = 'neutral', title, children }: { kind?: 'neutral' | 'danger' | 'win' | 'accent'; title?: string; children: ReactNode }) {
  const role = kind === 'danger' ? 'alert' : 'status';
  return (
    <div className={`notice ${kind === 'neutral' ? '' : kind}`} role={role}>
      <svg className="icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
        <circle cx="10" cy="10" r="7.5" />
        {kind === 'danger' ? <path d="M10 6v5M10 13.5v.5" /> : kind === 'win' ? <path d="M6.5 10.5 9 13l4.5-6" /> : <path d="M10 9v5M10 6.5v.5" />}
      </svg>
      <div>
        {title ? <p style={{ fontWeight: 600 }}>{title}</p> : null}
        {typeof children === 'string' ? <p>{children}</p> : children}
      </div>
    </div>
  );
}

export function TxStatusLine({ state }: { state: TxState }) {
  const dep = useDeployment();
  if (state.phase === 'idle') return <p className="status-line sr-only" role="status" />;
  const link = state.hash ? explorerTxUrl(dep.network?.explorer, state.hash) : undefined;
  const hashNode = state.hash ? (
    link ? (
      <a href={link} target="_blank" rel="noreferrer" className="mono">
        {shortHash(state.hash)}
      </a>
    ) : (
      <span className="mono">{shortHash(state.hash)}</span>
    )
  ) : null;
  if (state.phase === 'error') {
    return (
      <div className="notice danger" role="alert">
        <div>
          <p>{state.error}</p>
          {hashNode ? <p>Transaction {hashNode}</p> : null}
        </div>
      </div>
    );
  }
  const text =
    state.phase === 'simulating'
      ? `Checking ${state.label?.toLowerCase() ?? 'the transaction'} against the chain…`
      : state.phase === 'wallet'
        ? 'Confirm in your wallet…'
        : state.phase === 'pending'
          ? 'Waiting for confirmation…'
          : 'Confirmed.';
  return (
    <p className="status-line" role="status">
      {state.phase === 'confirmed' ? <span className="badge accent">Done</span> : <Spinner />}
      <span>{text}</span>
      {hashNode}
    </p>
  );
}

export function Card({ title, lede, children, className, headerExtra }: { title: string; lede?: string; children: ReactNode; className?: string; headerExtra?: ReactNode }) {
  return (
    <article className={`card ${className ?? ''}`} aria-labelledby={undefined}>
      <div className="card-header">
        <h3>{title}</h3>
        {headerExtra}
        {lede ? <p>{lede}</p> : null}
      </div>
      {children}
    </article>
  );
}
