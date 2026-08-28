export interface ScheduleViewOnlyBadgeProps {
  /**
   * May this reader still author dependency edges? (#3053)
   *
   * The Scheduler band, and the reason this badge stopped being binary. It is the
   * one role the server refuses task content (`can_author` false, so the authoring
   * apparatus is absent and this badge stands in its place) while ACCEPTING
   * dependency writes — so "change anything here" is a claim that is false for
   * exactly one of the readers who sees it.
   */
  canLinkDependencies?: boolean;
}

/**
 * What a reader sees where the authoring apparatus would be (#2949, #3053).
 *
 * A viewer is not "in Read mode" — there is no mode, because nothing is on
 * offer. So the toolbar's create buttons, the Read/Author toggle and the build
 * pill are absent rather than disabled, and this badge stands in their place
 * with the single fact that reader actually needs: what to do about it.
 *
 * **Two readers land here, not one.** The badge is placed by `hasEditRights`,
 * which is task content only — and the Schedule fronts a second, non-nested
 * permission for dependency edges (`IsProjectScheduler`). A Resource Manager
 * fails the first and passes the second, so they reach this badge while still
 * holding drag-to-link. Telling them to ask for rights "to change anything here"
 * would deny a capability they are exercising, and the likeliest reading is that
 * the link they just drew will not stick — the "product is broken" outcome the
 * badge exists to prevent, arriving through the fix for it (#3053).
 *
 * So the partial band gets its own sentence naming what it CAN do. Same shape,
 * same placement, different claim — a second badge would read as a second status.
 *
 * It is a static element, not a button. Giving it an action would put an
 * affordance back on a surface whose whole point is that it offers none.
 *
 * Deliberately no icon: a padlock reads as "blocked" and an eye-off reads as
 * "hidden", and neither is what this is. The words carry it.
 */
export function ScheduleViewOnlyBadge({ canLinkDependencies = false }: ScheduleViewOnlyBadgeProps = {}) {
  return (
    <div className="flex items-center gap-2 min-w-0" data-testid="schedule-view-only">
      <span
        className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-control border border-neutral-border
          bg-neutral-surface-sunken text-xs font-medium text-neutral-text-secondary flex-shrink-0"
      >
        {canLinkDependencies ? 'Links only' : 'View only'}
      </span>
      <span className="text-xs text-neutral-text-secondary truncate">
        {canLinkDependencies
          ? 'You can link tasks here. Ask the project owner for edit rights to change their content.'
          : 'Ask the project owner for edit rights to change anything here.'}
      </span>
    </div>
  );
}
