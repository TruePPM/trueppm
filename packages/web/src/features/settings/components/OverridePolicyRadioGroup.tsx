import { EnterpriseBadge } from './EnterpriseBadge';

export type OverridePolicyId = 'suggest' | 'inherit' | 'enforce';

export interface OverridePolicyOption {
  id: OverridePolicyId;
  label: string;
  hint: string;
  /** ENFORCE is a TruePPM Enterprise hard lock (ADR-0107/ADR-0441) — disabled
   *  on the OSS surface with the community-only upsell badge. The server
   *  degrades ENFORCE to SUGGEST when no enterprise provider is registered,
   *  so storing it is harmless. */
  enterprise: boolean;
}

interface OverridePolicyRadioGroupProps {
  /** Radio `name` — shared across every option so the group commits exclusively. */
  name: string;
  options: readonly OverridePolicyOption[];
  value: OverridePolicyId;
  onChange: (id: OverridePolicyId) => void;
  /** id of the sr-only hint the disabled (enterprise) option's `aria-describedby` points at. */
  enforceHintId: string;
  enforceHintText?: string;
}

/**
 * Suggest / Inherit / Enforce override-policy radio group, shared by the
 * workspace calendar and methodology settings pages (#3903) — the only two
 * override-policy fields whose ENFORCE option needs the Enterprise upsell
 * badge treatment (every other override policy uses a plain `<select>` via
 * `InheritableSelectField`).
 *
 * A disabled radio conveys nothing to a screen reader beyond "unavailable" —
 * the visual `EnterpriseBadge` next to the label doesn't reach non-visual
 * users, so the reason is spelled out via the sr-only hint named by
 * `enforceHintId` (accessibility gap fixed here, #1987 / web-rule 265 / #2001).
 */
export function OverridePolicyRadioGroup({
  name,
  options,
  value,
  onChange,
  enforceHintId,
  enforceHintText = 'Enforce requires TruePPM Enterprise.',
}: OverridePolicyRadioGroupProps) {
  return (
    <div className="px-4 py-3 space-y-2">
      {options.map((opt) => {
        const checked = value === opt.id;
        const disabled = opt.enterprise;
        return (
          <label
            key={opt.id}
            className={[
              'flex items-start gap-2.5 rounded-card p-2 group',
              disabled ? 'cursor-not-allowed' : 'cursor-pointer hover:bg-neutral-surface-sunken',
            ].join(' ')}
          >
            <span
              className={[
                'mt-0.5 w-4 h-4 rounded-full border-2 shrink-0 flex items-center justify-center transition-colors',
                checked && !disabled
                  ? 'border-brand-primary bg-brand-primary'
                  : 'border-neutral-border bg-neutral-surface',
              ].join(' ')}
              aria-hidden="true"
            >
              {checked && !disabled && <span className="w-1.5 h-1.5 rounded-full bg-white" />}
            </span>
            <input
              type="radio"
              name={name}
              value={opt.id}
              checked={checked}
              disabled={disabled}
              readOnly={disabled}
              aria-describedby={disabled ? enforceHintId : undefined}
              onChange={() => {
                if (!disabled) onChange(opt.id);
              }}
              className="sr-only"
            />
            <span className="flex flex-col">
              <span className="inline-flex items-center gap-1.5">
                <span
                  className={[
                    'text-[13px] font-medium',
                    disabled ? 'text-neutral-text-disabled' : 'text-neutral-text-primary',
                  ].join(' ')}
                >
                  {opt.label}
                </span>
                {opt.enterprise && <EnterpriseBadge />}
              </span>
              <span className="text-[12px] text-neutral-text-secondary">{opt.hint}</span>
            </span>
          </label>
        );
      })}
      <span id={enforceHintId} className="sr-only">
        {enforceHintText}
      </span>
    </div>
  );
}
