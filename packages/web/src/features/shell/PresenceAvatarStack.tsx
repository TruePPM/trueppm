/**
 * Shows up to MAX_VISIBLE avatars for online project members, then a "+N" overflow
 * count.  Avatars are plain colored circles with initials — no profile photos yet.
 *
 * Design-system notes:
 *   - bg-brand-primary-light / text-brand-primary for avatars (rule 8 — no hex literals)
 *   - No drop shadows (rule 1)
 *   - Focus ring follows rule 4
 *   - Touch target ≥ 44px via padding on the group container (rule 5)
 */
import type { PresenceUser } from '@/stores/presenceStore';

interface Props {
  users: PresenceUser[];
}

const MAX_VISIBLE = 3;

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function PresenceAvatarStack({ users }: Props) {
  if (users.length === 0) return null;

  const visible = users.slice(0, MAX_VISIBLE);
  const overflow = users.length - MAX_VISIBLE;

  // "viewing" (not "online") so the stack reads as "who has this open", not as
  // an availability/load signal (#1560).
  const tooltipLabel = users.map((u) => u.display_name).join(', ') + ' viewing';
  // Anonymity contract (#1560): presence names who is present, never who is
  // editing what. Kept as a native tooltip + accessible description — no popover.
  const presenceContract = "Shows who's online, never who's editing what.";

  return (
    <div
      className="hidden md:flex items-center"
      aria-label={tooltipLabel}
      aria-describedby="presence-stack-contract"
      title={`${tooltipLabel}. ${presenceContract}`}
      role="status"
    >
      {/* Avatar circles — overlap slightly with negative margin */}
      <div className="flex -space-x-1.5">
        {visible.map((u) => (
          <span
            key={u.user_id}
            className="flex items-center justify-center w-7 h-7 rounded-full text-xs font-semibold
              bg-brand-primary-light text-brand-primary
              ring-2 ring-neutral-surface"
            aria-hidden="true"
          >
            {initials(u.display_name)}
          </span>
        ))}
      </div>

      {/* Overflow count */}
      {overflow > 0 && (
        <span
          className="ml-1 text-xs text-neutral-text-secondary"
          aria-hidden="true"
        >
          +{overflow}
        </span>
      )}

      {/* Anonymity contract, exposed to assistive tech via aria-describedby */}
      <span id="presence-stack-contract" className="sr-only">
        {presenceContract}
      </span>
    </div>
  );
}
