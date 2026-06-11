import { usePresenceStore, type PresenceUser } from '@/stores/presenceStore';

const MAX_VISIBLE = 5;

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/**
 * "Who's in the retro" presence chips (ADR-0117 §4).
 *
 * Reads the project presence store (the retro reuses the existing
 * ProjectConsumer presence hash). Renders up to five initial avatars plus a
 * "+N" overflow; the whole group carries an aria-label listing every present
 * name so a screen reader hears the full roster, not just the truncated chips.
 */
export function RetroPresenceChips() {
  const usersById = usePresenceStore((s) => s.users);
  const users: PresenceUser[] = Object.values(usersById).sort((a, b) =>
    a.display_name.localeCompare(b.display_name),
  );

  if (users.length === 0) return null;

  const visible = users.slice(0, MAX_VISIBLE);
  const overflow = users.length - visible.length;
  const names = users.map((u) => u.display_name).join(', ');

  return (
    <div
      className="flex items-center -space-x-1"
      aria-label={`In this retro: ${names}`}
    >
      {visible.map((u) => (
        <span
          key={u.user_id}
          title={u.display_name}
          aria-hidden="true"
          className="inline-flex h-6 w-6 items-center justify-center rounded-full
            border border-neutral-surface bg-brand-primary text-white text-[10px] font-semibold tppm-mono"
        >
          {initials(u.display_name)}
        </span>
      ))}
      {overflow > 0 && (
        <span
          aria-hidden="true"
          className="inline-flex h-6 min-w-6 items-center justify-center rounded-full
            border border-neutral-surface bg-neutral-surface-sunken px-1 text-[10px] font-semibold tppm-mono text-neutral-text-secondary"
        >
          +{overflow}
        </span>
      )}
    </div>
  );
}
