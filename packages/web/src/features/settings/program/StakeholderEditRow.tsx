import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Button } from '@/components/Button';

/**
 * The one editable stakeholder row — used for BOTH "add" and "edit" (#2530,
 * design handoff #1658 §2).
 *
 * Forking a second form for edit is how the two paths drift: the add path would
 * keep the email validation and the edit path would quietly ship without it. One
 * component means the validation rule, the field order, and the commit/discard
 * affordance can only be decided once.
 *
 * The caller owns persistence and open/closed state; this component owns only the
 * draft, the client-side email check, and the Save/Cancel contract. In edit mode
 * the caller mounts it keyed by stakeholder id, so Cancel reverts simply by
 * unmounting the draft — there is no baseline to restore by hand.
 */

/**
 * Column ruler for the header and the read rows (an inline `gridTemplateColumns`).
 * The edit row cannot consume it directly — Tailwind's JIT cannot read a runtime
 * constant — so it restates the same ratios as a static class below, collapsing
 * the two fixed tracks into one action column. **Change one, change the other:**
 * `md:grid-cols-[1.4fr_1.6fr_1.6fr_234px]` where `234 = 118 + 116`.
 */
export const STAKEHOLDER_GRID = '1.4fr 1.6fr 1.6fr 118px 116px';

/**
 * Deliberately permissive: the server's `EmailField` is the authority on what is
 * deliverable. This only catches the shapes that cannot possibly be an address
 * (no `@`, no dot in the domain, embedded whitespace) so the user learns about a
 * typo before spending a round trip on it.
 */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface StakeholderDraft {
  name: string;
  email: string;
  note: string;
}

/** DRF field-error envelope from a failed create/update. */
export interface StakeholderFieldErrors {
  name?: string[];
  email?: string[];
  /** Non-field rejections (a closed program's 403, a 5xx) arrive as `detail`. */
  detail?: string;
}

interface StakeholderEditRowProps {
  mode: 'add' | 'edit';
  /** Baseline values in edit mode; omitted for a blank add row. */
  initial?: StakeholderDraft;
  /** Namespaces the field ids so several rows can coexist in one page. */
  idPrefix: string;
  /** Accessible name of the `<form>` region (rows are otherwise indistinguishable). */
  formLabel: string;
  submitLabel: string;
  isPending: boolean;
  fieldErrors?: StakeholderFieldErrors | null;
  /** Seat focus on the first field when the row opens (the edit case). */
  seatFocus?: boolean;
  className?: string;
  onSubmit: (draft: StakeholderDraft) => void;
  onCancel: () => void;
}

const FIELD_CLASS =
  'h-8 w-full rounded border border-neutral-border bg-neutral-surface px-2 text-sm text-neutral-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary';

const EMPTY: StakeholderDraft = { name: '', email: '', note: '' };

/** DRF field errors are `list[ErrorDetail]`; anything else is not renderable. */
function firstMessage(value: unknown): string | undefined {
  return Array.isArray(value) && typeof value[0] === 'string' ? value[0] : undefined;
}

export function StakeholderEditRow({
  mode,
  initial,
  idPrefix,
  formLabel,
  submitLabel,
  isPending,
  fieldErrors,
  seatFocus = false,
  className = '',
  onSubmit,
  onCancel,
}: StakeholderEditRowProps) {
  const baseline = initial ?? EMPTY;
  const [name, setName] = useState(baseline.name);
  const [email, setEmail] = useState(baseline.email);
  const [note, setNote] = useState(baseline.note);
  // The email check is advisory, so it must not shout at a half-typed address:
  // it only speaks once the user has left the field or tried to submit.
  const [emailChecked, setEmailChecked] = useState(false);
  // A server field error describes the value that was *sent*. The moment the user
  // edits that value the error is about something that no longer exists, so it is
  // suppressed locally rather than left to contradict the field beside it.
  const [serverErrorStale, setServerErrorStale] = useState(false);

  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    // The Edit button that opened this row has unmounted, so focus is on <body>
    // (rules 224/288). Seat it on the first field rather than making a keyboard
    // user Tab in from the top of the settings shell.
    if (seatFocus) nameRef.current?.focus();
  }, [seatFocus]);

  const trimmedName = name.trim();
  const trimmedEmail = email.trim();
  const emailMalformed = trimmedEmail !== '' && !EMAIL_RE.test(trimmedEmail);
  const showEmailHint = emailMalformed && emailChecked;

  const serverEmailError = serverErrorStale ? undefined : firstMessage(fieldErrors?.email);
  const serverNameError = serverErrorStale ? undefined : firstMessage(fieldErrors?.name);
  const serverDetail =
    serverErrorStale || typeof fieldErrors?.detail !== 'string' ? undefined : fieldErrors.detail;
  const helperMessage = showEmailHint
    ? 'Enter a valid email address.'
    : (serverEmailError ?? serverNameError ?? serverDetail);
  const helperId = `${idPrefix}-error`;

  // Rule 225: the invalid flag gates the primary action AND the submit handler,
  // so Enter can never commit the address the helper text is warning about.
  const isDirty =
    trimmedName !== baseline.name.trim() ||
    trimmedEmail !== baseline.email.trim() ||
    note.trim() !== baseline.note.trim();

  // Rule 217: Save stays inert until something actually changed, so re-opening a
  // row and pressing Save cannot fire a no-op PATCH.
  const canSubmit =
    trimmedName !== '' && trimmedEmail !== '' && !emailMalformed && !isPending && isDirty;

  // An add row has nothing to discard until the user types; an edit row always
  // offers the way back out.
  const showCancel = mode === 'edit' || isDirty;

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setEmailChecked(true);
    if (!canSubmit) return;
    // Un-suppress: whatever the server says about *this* attempt is current again.
    setServerErrorStale(false);
    onSubmit({ name: trimmedName, email: trimmedEmail, note: note.trim() });
  }

  function handleCancel() {
    if (mode === 'add') {
      setName(baseline.name);
      setEmail(baseline.email);
      setNote(baseline.note);
      setEmailChecked(false);
    }
    onCancel();
  }

  // Escape is the conventional discard for an inline edit. Bound to the row's own
  // controls rather than to a document listener, which would double-fire against
  // the settings shell's handler (the rule-204 lesson), and rather than to the
  // <form>, which is not an interactive element (jsx-a11y).
  function handleKeyDown(e: KeyboardEvent<HTMLElement>) {
    if (e.key !== 'Escape' || !showCancel) return;
    e.stopPropagation();
    handleCancel();
  }

  return (
    <form onSubmit={handleSubmit} aria-label={formLabel} className={`space-y-2 ${className}`}>
      <div className="grid grid-cols-1 gap-2 md:grid-cols-[1.4fr_1.6fr_1.6fr_234px] md:items-center">
        <div>
          <label htmlFor={`${idPrefix}-name`} className="sr-only">
            Name
          </label>
          <input
            id={`${idPrefix}-name`}
            ref={nameRef}
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setServerErrorStale(true);
            }}
            placeholder="Name"
            aria-invalid={serverNameError ? true : undefined}
            aria-describedby={serverNameError ? helperId : undefined}
            onKeyDown={handleKeyDown}
            className={FIELD_CLASS}
          />
        </div>
        <div>
          <label htmlFor={`${idPrefix}-email`} className="sr-only">
            Email
          </label>
          <input
            id={`${idPrefix}-email`}
            type="email"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              setServerErrorStale(true);
            }}
            onBlur={() => setEmailChecked(true)}
            placeholder="email@example.com"
            aria-invalid={showEmailHint || serverEmailError ? true : undefined}
            aria-describedby={showEmailHint || serverEmailError ? helperId : undefined}
            onKeyDown={handleKeyDown}
            className={FIELD_CLASS}
          />
        </div>
        <div>
          <label htmlFor={`${idPrefix}-note`} className="sr-only">
            Note (optional)
          </label>
          <input
            id={`${idPrefix}-note`}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Note (optional)"
            onKeyDown={handleKeyDown}
            className={FIELD_CLASS}
          />
        </div>
        <div className="flex items-center gap-2 md:justify-end">
          <Button type="submit" size="sm" onKeyDown={handleKeyDown} disabled={!canSubmit}>
            {submitLabel}
          </Button>
          {showCancel && (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onKeyDown={handleKeyDown}
              onClick={handleCancel}
              disabled={isPending}
            >
              Cancel
            </Button>
          )}
        </div>
      </div>
      {helperMessage && (
        <p id={helperId} role="alert" className="text-xs text-semantic-critical">
          {helperMessage}
        </p>
      )}
    </form>
  );
}
