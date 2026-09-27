import type { ReactNode } from 'react';
import type { KeyStatus } from './useKeyStatus';

interface KeyStatusLineProps {
  /** Referenced by the key input's `aria-describedby`. */
  id: string;
  status: KeyStatus;
  /** Set the field to the server's suggested free key ("try PM2"). */
  onUseSuggestion: (suggestion: string) => void;
}

/**
 * The key field's one-line status (ADR-1237 UX §1): `✓ Available`, `Checking…`,
 * `Already in use — try PM2`, `That word is reserved`, or a format / server message.
 *
 * Always mounted, even when empty, so it is a stable `aria-live="polite"` region:
 * a live region inserted together with its first message is often not announced.
 * Color is never the only signal — every state carries its own words.
 */
export function KeyStatusLine({ id, status, onUseSuggestion }: KeyStatusLineProps) {
  let content: ReactNode = null;
  let tone = 'text-neutral-text-secondary';
  switch (status.state) {
    case 'available':
      tone = 'text-semantic-on-track';
      content = (
        <>
          <span aria-hidden="true">✓ </span>Available
        </>
      );
      break;
    case 'checking':
      content = 'Checking…';
      break;
    case 'taken':
      tone = 'text-semantic-critical';
      content = (
        <>
          Already in use — try{' '}
          {/* 44px hit area on touch without growing the line (UX §3 "Mobile"). */}
          <button
            type="button"
            onClick={() => onUseSuggestion(status.suggestion)}
            aria-label={`Use ${status.suggestion}`}
            className="tppm-mono -my-3 rounded-control py-3 font-medium underline underline-offset-2 hover:no-underline focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1"
          >
            {status.suggestion}
          </button>
        </>
      );
      break;
    case 'reserved':
      tone = 'text-semantic-critical';
      content = 'That word is reserved';
      break;
    case 'error':
      tone = 'text-semantic-critical';
      content = status.message;
      break;
    case 'none':
      break;
  }
  return (
    <p id={id} role="status" aria-live="polite" className={`min-h-[1rem] text-xs ${tone}`}>
      {content}
    </p>
  );
}
