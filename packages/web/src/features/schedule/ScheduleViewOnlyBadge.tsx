/**
 * The one thing a viewer sees where the authoring apparatus would be (#2949).
 *
 * A viewer is not "in Read mode" — there is no mode, because nothing is on
 * offer. So the toolbar's create buttons, the Read/Author toggle and the build
 * pill are absent rather than disabled, and this badge stands in their place
 * with the single fact a viewer actually needs: what to do about it.
 *
 * It is a static element, not a button. Giving it an action would put an
 * affordance back on a surface whose whole point is that it offers none.
 *
 * Deliberately no icon: a padlock reads as "blocked" and an eye-off reads as
 * "hidden", and neither is what this is. The words carry it.
 */
export function ScheduleViewOnlyBadge() {
  return (
    <div className="flex items-center gap-2 min-w-0" data-testid="schedule-view-only">
      <span
        className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-control border border-neutral-border
          bg-neutral-surface-sunken text-xs font-medium text-neutral-text-secondary flex-shrink-0"
      >
        View only
      </span>
      <span className="text-xs text-neutral-text-secondary truncate">
        Ask the project owner for edit rights to change anything here.
      </span>
    </div>
  );
}
