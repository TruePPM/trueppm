/**
 * Tiny initials avatar for a backlog item's owner. Decorative ring only — the
 * member's full name is always supplied as the accessible label so screen
 * readers announce "Riya Kapoor", not "RK".
 */

interface AvatarProps {
  initials: string;
  name: string;
  /** Pixel size of the circle. Default 20 (list rows). */
  size?: number;
  className?: string;
}

export function Avatar({ initials, name, size = 20, className = '' }: AvatarProps) {
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center rounded-full bg-brand-primary-light
        font-medium uppercase text-brand-primary-dark ${className}`}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.42) }}
      title={name}
      aria-label={name}
      role="img"
    >
      {initials}
    </span>
  );
}
