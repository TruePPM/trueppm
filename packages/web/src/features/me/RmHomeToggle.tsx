import { useId } from 'react';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useUpdateHomeOverride } from '@/hooks/useHomeOverride';
import { useFeatureFlag } from '@/lib/featureFlags';
import { SHELL_V2_FLAG } from '@/features/shell2/shellFlag';

/**
 * Preferences control for the Resource Manager home (#5107): shell v2 only. On means
 * `home_override = rm`; off clears it back to the role-resolved home. The checked state
 * is read from `landing.home`, since `rm` is reachable only through this override.
 */
export function RmHomeToggle({ offline }: { offline: boolean }) {
  const v2 = useFeatureFlag(SHELL_V2_FLAG);
  const { user } = useCurrentUser();
  const update = useUpdateHomeOverride();
  const id = useId();
  if (!v2) return null;
  const checked = user?.landing?.home === 'rm';
  return (
    <section
      aria-labelledby={`${id}-h`}
      className="flex flex-col gap-2 rounded-card border border-neutral-border p-4"
    >
      <h2 id={`${id}-h`} className="text-sm font-semibold text-neutral-text-primary">
        Home screen
      </h2>
      <label
        htmlFor={id}
        className="flex min-h-[44px] cursor-pointer items-start gap-3 text-sm text-neutral-text-primary"
      >
        <input
          id={id}
          type="checkbox"
          className="mt-1 h-4 w-4"
          checked={checked}
          disabled={offline || update.isPending}
          onChange={(e) => update.mutate(e.target.checked ? 'rm' : null)}
        />
        <span>
          Open on the Resource Manager home
          <span className="block text-neutral-text-secondary">
            Shows team capacity first. Turn it off to open on the home that fits your role.
          </span>
        </span>
      </label>
      {update.isError && (
        <p role="alert" className="text-sm text-semantic-critical">
          Couldn&rsquo;t save your home screen. Try again.
        </p>
      )}
      {offline && (
        <p className="text-xs text-neutral-text-secondary">
          You&rsquo;re offline — reconnect to change your home screen.
        </p>
      )}
    </section>
  );
}
