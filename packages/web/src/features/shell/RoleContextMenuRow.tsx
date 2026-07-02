/**
 * Inline "View focus" lens switcher for the UserMenu (issue 1263, ADR-0162).
 *
 * Mirrors the Theme row: a `justify-between` plain row (label + a compact
 * segmented control), NOT a `role="menuitem"` — the segmented owns its own
 * `role="group"`/`aria-pressed` semantics and the menu container keeps
 * `role="menu"`. Self-contained: reads the current lens from `useCurrentUser`,
 * writes via `useUpdateRoleContext`, applies the change optimistically and
 * reverts on error (the reverted selection + an `aria-live` line are the error
 * feedback). The lens is presentation-only — switching it never changes access.
 */
import { useState } from 'react';
import { useCurrentUser, type RoleContext } from '@/hooks/useCurrentUser';
import { useUpdateRoleContext } from '@/hooks/useRoleContext';
import { ROLE_CONTEXT_CHOICES, ROLE_CONTEXT_LABEL } from '@/features/me/roleContext';

function RoleContextSegmented({
  value,
  onChange,
  disabled,
  isMobile,
}: {
  value: RoleContext;
  onChange: (value: RoleContext) => void;
  disabled: boolean;
  isMobile: boolean;
}) {
  return (
    <div
      role="group"
      aria-label={ROLE_CONTEXT_LABEL}
      className="flex items-center rounded border border-neutral-border"
    >
      {ROLE_CONTEXT_CHOICES.map((choice, i) => {
        const selected = value === choice.value;
        const isFirst = i === 0;
        const isLast = i === ROLE_CONTEXT_CHOICES.length - 1;
        return (
          <button
            key={choice.value}
            type="button"
            disabled={disabled}
            onClick={() => onChange(choice.value)}
            aria-pressed={selected}
            aria-label={choice.label}
            className={[
              'flex items-center justify-center',
              // 44px touch target on the mobile bottom sheet (rule 5); compact on desktop.
              isMobile ? 'min-h-[44px] px-3 text-sm' : 'h-7 px-2.5 text-xs',
              'focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1 focus:ring-offset-chrome-surface',
              'disabled:cursor-not-allowed disabled:text-neutral-text-disabled',
              isFirst ? 'rounded-l' : '',
              isLast ? 'rounded-r' : 'border-r border-neutral-border',
              selected
                ? // Active fill must CONTRAST against the menu surface, never a same-family
                  // surface shade (rule 179 / WCAG 1.4.1). brand-primary is a sanctioned
                  // active-accent (rule 35); font-medium is the extra non-color cue (rule 4).
                  'bg-brand-primary font-medium text-neutral-text-inverse'
                : 'text-neutral-text-secondary hover:bg-neutral-surface-raised hover:text-neutral-text-primary',
            ].join(' ')}
          >
            {choice.shortLabel}
          </button>
        );
      })}
    </div>
  );
}

export function RoleContextMenuRow({ isMobile }: { isMobile: boolean }) {
  const { user } = useCurrentUser();
  const update = useUpdateRoleContext();
  // Optimistic selection — seeded from the server value, reverted on error.
  const [selected, setSelected] = useState<RoleContext | null>(null);

  const serverValue: RoleContext = user?.role_context ?? 'unified';
  const value: RoleContext = selected ?? serverValue;
  const offline = typeof navigator !== 'undefined' && navigator.onLine === false;

  const rowBase = isMobile
    ? 'flex items-center px-4 min-h-[52px]'
    : 'flex items-center px-4 min-h-[36px]';

  function handleSelect(next: RoleContext) {
    if (next === value || offline) return;
    const previous = value;
    setSelected(next); // optimistic
    update.mutate(next, { onError: () => setSelected(previous) });
  }

  return (
    <div className="flex flex-col">
      <div className={`${rowBase} justify-between`}>
        <span className="text-sm text-neutral-text-primary">{ROLE_CONTEXT_LABEL}</span>
        <RoleContextSegmented
          value={value}
          onChange={handleSelect}
          disabled={offline || update.isPending}
          isMobile={isMobile}
        />
      </div>
      {update.isError && (
        <p role="status" aria-live="polite" className="px-4 pb-1 text-xs text-semantic-critical">
          Couldn&rsquo;t save. Try again.
        </p>
      )}
    </div>
  );
}
