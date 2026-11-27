import { useId } from 'react';
import { type EncryptionChoice, type EncryptionDraft, encryptionProblem } from './exportEncryption';

const inputClass = [
  'w-full px-2 py-1.5 rounded-control border border-neutral-border bg-neutral-surface text-[12px]',
  'text-neutral-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary',
].join(' ');

const CHOICES: { value: EncryptionChoice; label: string }[] = [
  { value: 'none', label: 'Don’t encrypt' },
  { value: 'passphrase', label: 'Passphrase' },
  { value: 'recipient', label: 'age public key' },
];

/**
 * Opt-in encryption controls for an export bundle card (issue 2400). Off by default:
 * a silently-encrypted file the user cannot open is worse than a plaintext one
 * they chose. The passphrase path requires an explicit "I can't get this back"
 * acknowledgement, because the server never keeps the passphrase.
 */
export function ExportEncryptionFields({
  draft,
  onChange,
  disabled,
}: {
  draft: EncryptionDraft;
  onChange: (next: EncryptionDraft) => void;
  disabled?: boolean;
}) {
  const id = useId();
  const problem = draft.choice === 'none' ? null : encryptionProblem(draft);
  const set = (patch: Partial<EncryptionDraft>) => onChange({ ...draft, ...patch });

  return (
    <fieldset className="mb-3" disabled={disabled}>
      <legend className="text-[12px] font-medium text-neutral-text-primary mb-1">
        Encryption (optional)
      </legend>
      <div role="radiogroup" aria-label="Encryption" className="flex flex-wrap gap-3 mb-2">
        {CHOICES.map((c) => (
          <label
            key={c.value}
            className="flex items-center gap-1.5 text-[12px] text-neutral-text-primary min-h-[44px] sm:min-h-0"
          >
            <input
              type="radio"
              name={`${id}-encryption`}
              value={c.value}
              checked={draft.choice === c.value}
              onChange={() => set({ choice: c.value })}
            />
            {c.label}
          </label>
        ))}
      </div>

      {draft.choice === 'passphrase' ? (
        <div className="space-y-2">
          <label className="block text-[11px] text-neutral-text-secondary">
            Choose a passphrase (at least 12 characters)
            <input
              type="password"
              autoComplete="new-password"
              className={inputClass}
              value={draft.passphrase}
              onChange={(e) => set({ passphrase: e.target.value })}
            />
          </label>
          <label className="block text-[11px] text-neutral-text-secondary">
            Confirm passphrase
            <input
              type="password"
              autoComplete="new-password"
              className={inputClass}
              value={draft.confirm}
              onChange={(e) => set({ confirm: e.target.value })}
            />
          </label>
          <div className="rounded-control border border-semantic-warning/40 bg-semantic-warning/10 p-2">
            <p className="text-[11px] text-neutral-text-primary leading-relaxed">
              TruePPM doesn’t keep this passphrase. If you lose it, nobody can open this bundle —
              you’d build a new one instead. You’ll need it again to import the bundle.
            </p>
            <label className="mt-1.5 flex items-start gap-1.5 text-[11px] text-neutral-text-primary">
              <input
                type="checkbox"
                checked={draft.acknowledged}
                onChange={(e) => set({ acknowledged: e.target.checked })}
              />
              I understand a lost passphrase can’t be recovered.
            </label>
          </div>
        </div>
      ) : null}

      {draft.choice === 'recipient' ? (
        <label className="block text-[11px] text-neutral-text-secondary">
          age public key
          <input
            type="text"
            spellCheck={false}
            autoComplete="off"
            placeholder="age1…"
            className={`${inputClass} font-mono`}
            value={draft.recipient}
            onChange={(e) => set({ recipient: e.target.value })}
          />
          <span className="mt-1 block">
            For an offsite archive. Open it with <code>age -d -i &lt;your key file&gt;</code>.
          </span>
        </label>
      ) : null}

      {problem ? (
        <p className="mt-1.5 text-[11px] text-neutral-text-secondary" aria-live="polite">
          {problem}
        </p>
      ) : null}
    </fieldset>
  );
}
