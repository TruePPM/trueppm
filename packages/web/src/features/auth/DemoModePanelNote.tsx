/**
 * The read-only demo's announcement on the login screen's marketing panel
 * (ADR-1197 D3, #3926).
 *
 * Says what the demo *is* before the visitor signs in, and scopes the promise
 * honestly: the schedule cascade is genuinely interactive because it recomputes in
 * the browser, and everything else is populated sample data they can read but not
 * change. Over-promising here is what turns D3's refusal into "the product is broken"
 * — the exact failure D3 exists to prevent.
 *
 * `relative` is required: the panel's decorative grid `<svg>` is `absolute inset-0`,
 * and both existing children carry it for the same reason.
 */
export function DemoModePanelNote() {
  return (
    <div className="relative rounded-card border border-chrome-border bg-chrome-surface-raised p-4 max-w-sm flex flex-col gap-2">
      <div className="inline-flex items-center gap-1.5 text-sm font-semibold text-chrome-text-primary">
        <span aria-hidden="true">◆</span> Read-only demo
      </div>
      <p className="text-xs leading-relaxed text-chrome-text-secondary">
        Drag a task on the Schedule and watch the critical path recompute in your browser. Nothing
        you do here is saved.
      </p>
      <p className="text-xs leading-relaxed text-chrome-text-secondary">
        This demo shows the scheduling engine. Boards, backlogs, sprints and resource plans are
        populated with real sample data — you can look at them, but you can&apos;t change them.
      </p>
    </div>
  );
}
