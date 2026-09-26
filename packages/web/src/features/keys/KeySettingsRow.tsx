import { useCallback, useId, useState } from 'react';
import { CopyIcon } from '@/components/Icons';
import { FieldRow } from '@/features/settings/SettingsShell';
import { programPath, projectPath, type RefKind } from '@/lib/refPath';
import { KEY_MAX_LENGTH, normalizeKeyInput } from './keyFormat';
import { KeyStatusLine } from './KeyStatusLine';
import { useKeyStatus } from './useKeyStatus';

/** ADR-1237 threat model: an object may retire at most this many keys. */
export const RETIRED_KEY_CAP = 10;

const CAP_COPY =
  'This key has been changed 10 times, the most allowed. Contact your workspace admin';

const HINT: Record<RefKind, string> = {
  project: 'Used in links and IDs like PM-T-12. Letters and digits, 2–10 characters.',
  program: 'Used in this program’s link.',
};

interface KeySettingsRowProps {
  kind: RefKind;
  /** The object's UUID — sent as `object_id` so its own keys read as available. */
  objectId: string | undefined;
  /** The field's current (draft) value. */
  value: string;
  onChange: (next: string) => void;
  /** The key as last saved; the check and the old-links note run only when `value` differs. */
  savedKey: string;
  /** `retired_key_count` from the detail response; at the cap the field is read-only. */
  retiredKeyCount: number | null | undefined;
  /** Whether the caller can edit General settings. Read-only renders text + copy-link. */
  canEdit: boolean;
  /** The last `400` on `code` from the save, verbatim; cleared by the page on edit. */
  serverError: string | null;
}

/**
 * The "Project key" / "Program key" row on a General settings page (ADR-1237 UX §2).
 *
 * Editable: the same status line and debounce as the create form, but it checks
 * only a value that differs from the saved key — the saved key is already this
 * object's. A changed value adds the old-links note: a rename is recoverable (the
 * old key stays this object's and keeps resolving), so the save bar commits it
 * with no confirm modal.
 *
 * At {@link RETIRED_KEY_CAP} retired keys the input is read-only and the hint states
 * the cap. For a caller who cannot edit General settings the key is plain mono text
 * with a copy-link button. That button must render **outside** the page's
 * `StubFieldset` — a disabled fieldset disables every descendant button — which is
 * why the pages mount this row between two fieldsets.
 */
export function KeySettingsRow({
  kind,
  objectId,
  value,
  onChange,
  savedKey,
  retiredKeyCount,
  canEdit,
  serverError,
}: KeySettingsRowProps) {
  const noun = kind === 'project' ? 'project' : 'program';
  const label = kind === 'project' ? 'Project key' : 'Program key';
  const changed = value !== savedKey;
  const atCap = (retiredKeyCount ?? 0) >= RETIRED_KEY_CAP;
  const { status } = useKeyStatus(kind, value, {
    check: canEdit && changed && !atCap,
    objectId,
    serverError,
  });
  const statusId = useId();
  const noteId = useId();

  const [copied, setCopied] = useState(false);
  const copyLink = useCallback(async () => {
    if (!objectId) return;
    const target = { id: objectId, code: savedKey };
    const path = kind === 'project' ? projectPath(target) : programPath(target);
    try {
      await navigator.clipboard.writeText(`${window.location.origin}${path}`);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard denied (insecure context / permissions) — the key is on screen.
    }
  }, [kind, objectId, savedKey]);

  if (!canEdit) {
    return (
      <FieldRow label={label} hint={HINT[kind]}>
        <div className="flex items-center gap-2">
          <span className="tppm-mono text-[13px] text-neutral-text-primary">{savedKey || '—'}</span>
          {savedKey && (
            <button
              type="button"
              onClick={() => void copyLink()}
              aria-label={`Copy ${noun} link`}
              title={copied ? 'Copied' : `Copy ${noun} link`}
              className="inline-flex h-8 w-8 items-center justify-center rounded-control text-neutral-text-secondary hover:bg-neutral-surface-raised hover:text-neutral-text-primary focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1"
            >
              <CopyIcon aria-hidden="true" className="h-3.5 w-3.5" />
            </button>
          )}
          <span role="status" aria-live="polite" className="text-xs text-neutral-text-secondary">
            {copied ? 'Copied' : ''}
          </span>
        </div>
      </FieldRow>
    );
  }

  return (
    <FieldRow label={label} hint={atCap ? CAP_COPY : HINT[kind]}>
      {({ hintId }) => (
        <div className="flex flex-col gap-1">
          <input
            type="text"
            value={value}
            onChange={(e) => onChange(normalizeKeyInput(kind, e.target.value))}
            readOnly={atCap}
            // A grandfathered pre-0.4 key may be longer than the new-key maximum.
            maxLength={Math.max(KEY_MAX_LENGTH[kind], savedKey.length)}
            autoComplete="off"
            spellCheck={false}
            aria-label={label}
            aria-describedby={[statusId, changed ? noteId : null, hintId].filter(Boolean).join(' ')}
            aria-invalid={status.state === 'error' || status.state === 'taken' || undefined}
            className={`${
              kind === 'project' ? 'w-[140px]' : 'w-full max-w-[420px]'
            } h-8 px-2.5 rounded-control border border-neutral-border bg-neutral-surface-raised text-[13px] tppm-mono text-neutral-text-primary read-only:text-neutral-text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary`}
          />
          <KeyStatusLine id={statusId} status={status} onUseSuggestion={onChange} />
          {changed && savedKey && (
            <p id={noteId} className="text-xs text-neutral-text-secondary">
              Old links using <strong className="tppm-mono font-medium">{savedKey}</strong> will
              keep working and open this {noun}.{' '}
              <strong className="tppm-mono font-medium">{savedKey}</strong> can&rsquo;t be used by
              another {noun}.
            </p>
          )}
        </div>
      )}
    </FieldRow>
  );
}
