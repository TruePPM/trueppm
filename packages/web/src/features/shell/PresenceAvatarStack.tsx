/**
 * Shows up to MAX_VISIBLE avatars for online project members, then a "+N" overflow
 * count.  Avatars are plain colored circles with initials — no profile photos yet.
 *
 * Dimensions follow the approved top-bar identity design (§02, #1804): 24 px
 * avatars with a −9 px overlap, capped at 2 visible + "+N" — deliberately
 * smaller and stacked so the cluster reads as ambient presence, never as a
 * second identity chip competing with the full-size "me" avatar.
 *
 * Design-system notes:
 *   - Circles render via the canonical AvatarInitials treatment (#1705). Its
 *     fill is translucent (`bg-brand-primary/15`), so each overlapping circle
 *     sits on an opaque `bg-chrome-surface` underlay matching the cutout ring —
 *     otherwise the overlap region double-tints and the under-avatar's initials
 *     ghost through (rule 251).
 *   - No drop shadows (rule 1)
 *   - Non-interactive (role="status"), so the 44px touch-target rule 5 does
 *     not apply.
 */
import { AvatarInitials } from '@/components/AvatarInitials';
import type { PresenceUser } from '@/stores/presenceStore';

interface Props {
  users: PresenceUser[];
}

const MAX_VISIBLE = 2;

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
      {/* Avatar circles — overlap slightly with negative margin. The rightmost
          (top-of-stack, unobstructed) avatar carries a green "viewing now" dot so
          the cluster reads as live presence — differentiating it at a glance from
          the solid full-size "me" identity chip further along the bar (#1736,
          design §02). The dot is decorative (aria-hidden with the avatar); the
          "viewing" state is already named in the group aria-label + title. Green
          matches the StatusBar "Live" dot (rule 44). */}
      <div className="flex -space-x-[9px]">
        {visible.map((u, i) => (
          <span
            key={u.user_id}
            className="relative flex rounded-full bg-chrome-surface"
            aria-hidden="true"
          >
            <AvatarInitials
              initials={initials(u.display_name)}
              size="sm"
              className="ring-2 ring-chrome-surface"
            />
            {i === visible.length - 1 && (
              <span className="absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full bg-semantic-on-track ring-2 ring-chrome-surface" />
            )}
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
