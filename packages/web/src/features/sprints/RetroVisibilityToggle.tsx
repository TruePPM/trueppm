import type { RetroVisibility } from '@/hooks/useSprints';

interface Props {
  value: RetroVisibility;
  disabled?: boolean;
  onChange: (next: RetroVisibility) => void;
}

const OPTIONS: ReadonlyArray<{ value: RetroVisibility; label: string }> = [
  { value: 'team_only', label: 'Team only' },
  { value: 'project', label: 'Project' },
  { value: 'org', label: 'Org' },
];

/**
 * Three-state segmented control for retro visibility (ADR-0071 §3).
 *
 * Only rendered for the retro's ``created_by`` or Project ADMIN+ users; the
 * server enforces the same gate on PATCH and 403s any other caller.
 */
export function RetroVisibilityToggle({ value, disabled, onChange }: Props) {
  return (
    <div
      role="radiogroup"
      aria-label="Retrospective visibility"
      className="inline-flex items-center gap-0.5 rounded border border-neutral-border bg-neutral-surface-raised p-0.5"
    >
      {OPTIONS.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled}
            onClick={() => onChange(opt.value)}
            className={`inline-flex min-h-[44px] items-center px-3 rounded text-xs font-medium whitespace-nowrap
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1
              ${
                active
                  ? 'bg-brand-primary text-white'
                  : 'text-neutral-text-secondary hover:bg-neutral-surface-sunken'
              }
              disabled:opacity-50 disabled:cursor-not-allowed`}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
