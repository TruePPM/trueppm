/**
 * Shown instead of the "No stories yet" empty state while a just-applied template's
 * rows are still streaming in over the board WebSocket (#2734, ADR-0800).
 *
 * The Start sheet fires the template apply and navigates immediately without
 * waiting for it (ADR-0789 §4 — never block on seeding), so the backlog can be
 * genuinely empty for a moment after landing here. Without this, the page would
 * show the ordinary empty-backlog CTA ("Pull items from the program backlog, or add
 * a story below") for however long the seed job takes — the same "add your first
 * task" first impression #2734 exists to remove, one route over. This is a pure
 * skeleton — the moment the first seeded row arrives, `ProductBacklogPage`'s
 * `allEmpty` flips to `false` and this stops rendering on its own; no polling.
 */
export function BacklogSeedingState() {
  return (
    <div role="status" aria-label="Setting up your backlog" className="flex flex-col gap-2 p-6">
      <p className="mb-2 text-[13px] text-neutral-text-secondary">Setting up your backlog…</p>
      {Array.from({ length: 4 }).map((_, i) => (
        <div
          key={i}
          aria-hidden="true"
          className="h-11 rounded-card bg-neutral-surface-sunken motion-safe:animate-pulse"
        />
      ))}
    </div>
  );
}
