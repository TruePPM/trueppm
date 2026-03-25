/**
 * Tooltip icon shown next to a resource name when calendar_differs_from_project=true. Rule 96.
 * Uses a native title for simplicity; a Radix Tooltip can replace this later.
 */
export function CalendarMismatchTooltip() {
  return (
    <span
      className="inline-flex items-center ml-1 text-neutral-text-secondary cursor-help"
      title="This resource uses a different calendar than the project. Load is computed from the resource's calendar."
      aria-label="Calendar differs from project calendar"
    >
      ⓘ
    </span>
  );
}
