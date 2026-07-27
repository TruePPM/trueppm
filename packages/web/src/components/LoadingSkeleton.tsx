// ---------------------------------------------------------------------------
// LoadingSkeleton — the shared rule-248 loading ghost.
//
// Rule 248 requires every loading state to be a skeleton mirroring the shape of
// the real content, never a bare "Loading…" text line. The primary surfaces each
// hand-rolled their own (a board's column ghosts can't be shared with a grid's
// row ghosts), but two classes of loading state had no surface shape to mirror
// and so kept rendering the bare text the rule forbids:
//
//   - the route-level Suspense fallback, which is the *first frame of every
//     navigation* and does not yet know which surface is arriving (#2431);
//   - in-page settings sections, whose ghosts are all the same stack of rows.
//
// Both get their shape from this component instead. The `role="status"` wrapper
// carries the accessible name and is the node E2E's wait-for-paint gate resolves
// on when it detaches, so callers must pass a rule-248 "Loading X…" label. Every
// ghost child is `aria-hidden` — the name lives on the wrapper, so a screen
// reader hears one status, not a dozen empty boxes.
// ---------------------------------------------------------------------------

/** A single pulsing placeholder block. `motion-safe:` honors reduced-motion. */
function Ghost({ className }: { className: string }) {
  return (
    <div
      aria-hidden="true"
      className={`motion-safe:animate-pulse bg-neutral-surface-sunken ${className}`}
    />
  );
}

export interface LoadingSkeletonProps {
  /**
   * Accessible name for the status node, in rule-248 form — e.g. `"Loading
   * members…"`. E2E specs gate on `getByRole('status', { name: /Loading X/i })`
   * detaching, so this string is part of the surface's test contract.
   */
  label: string;
  /**
   * `shell` — a full route body: a toolbar band above a stack of content ghosts.
   * Used by the Suspense fallback, where the arriving surface is not yet known.
   *
   * `rows` — a compact stack sized for an in-page settings section, honoring the
   * settings density exception (which covers size, not the skeleton contract).
   */
  variant?: 'shell' | 'rows';
  /** How many content ghosts to render. */
  rows?: number;
  /** Extra classes on the status wrapper — spacing is the caller's business. */
  className?: string;
}

/**
 * Render a rule-248 skeleton ghost for a loading data surface.
 *
 * Prefer a surface-specific skeleton when the real content has a distinctive
 * shape worth mirroring (board columns, grid rows). Reach for this when the
 * shape is generic — a route chunk still resolving, or a settings section that
 * is just a stack of field rows.
 */
export function LoadingSkeleton({
  label,
  variant = 'rows',
  rows = 3,
  className = '',
}: LoadingSkeletonProps) {
  if (variant === 'shell') {
    return (
      <div role="status" aria-label={label} className={`flex h-full flex-col gap-4 p-4 ${className}`}>
        {/* Toolbar band — every surface opens with one, so ghosting it keeps the
            layout from jumping when the real toolbar paints. */}
        <div className="flex items-center gap-3">
          <Ghost className="h-7 w-44 rounded-chip" />
          <Ghost className="h-7 w-24 rounded-chip" />
          <div className="flex-1" />
          <Ghost className="h-7 w-20 rounded-chip" />
        </div>
        <div className="flex flex-1 flex-col gap-3 overflow-hidden">
          {Array.from({ length: rows }).map((_, i) => (
            <Ghost key={i} className="h-16 rounded-card border border-neutral-border" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div role="status" aria-label={label} className={`flex flex-col gap-2 ${className}`}>
      {Array.from({ length: rows }).map((_, i) => (
        <Ghost key={i} className="h-9 rounded-card border border-neutral-border" />
      ))}
    </div>
  );
}
