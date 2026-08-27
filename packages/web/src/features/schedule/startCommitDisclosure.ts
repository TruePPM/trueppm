/**
 * What committing a start actually does, said before the click and after it (#3075).
 *
 * `PATCH { planned_start }` on a NOT_STARTED task does more than set a date. When the
 * date is `<= today` the server injects `status: IN_PROGRESS`
 * (`TaskEditSerializer._apply_date_gated_start_transition`, #336), and for a date
 * strictly in the past it also back-stamps `actual_start = planned_start`.
 *
 * The transition itself is right — a task whose committed start has arrived *is*
 * underway. What was wrong is that two controls named for a date effected a status
 * change with no disclosure: the unscheduled gutter's quick actions and `Promote to
 * schedule`, and the drawer's *Set committed start*, which sits about 150px above the
 * Status select it silently changes.
 *
 * **Both surfaces read this module, and neither re-derives the rule.** Disclosing on one
 * only would leave the two paths making different promises about the same write, which
 * is the drift #3063 was written to remove.
 *
 * ## Whose "today"
 *
 * The server's, and nothing else will do. The rule is gated on Django's
 * `timezone.localdate()` under `settings.TIME_ZONE`; a browser-side `new Date()`
 * disagrees with it across a timezone boundary, which is the one case where the answer
 * matters, and a hint that is wrong at the boundary is worse than no hint. So the date
 * comes from the project payload's `server_date` (#3075) and this module takes it as an
 * argument rather than reaching for a clock.
 *
 * When `serverDate` is not available — the project query has not resolved, or an older
 * server does not send it — every function here returns `null` and the caller keeps its
 * existing copy. Silence is the correct failure mode: the label is a promise about what
 * a click will do, and a guess is not one.
 */

/** The outcome the server will apply on top of the date, or `null` for none. */
export type StartCommitEffect = 'none' | 'in_progress' | 'in_progress_backdated';

/**
 * What the server will do beyond setting the date, or `null` when it cannot be known.
 *
 * `null` means "no server date to compare against" — deliberately distinct from
 * `'none'`, which is the positive claim that the date is in the future and nothing else
 * will happen.
 */
export function startCommitEffect(
  startIso: string | null | undefined,
  serverDate: string | null | undefined,
): StartCommitEffect | null {
  if (!startIso || !serverDate) return null;
  // ISO `YYYY-MM-DD` compares correctly as a string, and doing it that way avoids
  // constructing a Date — which would reintroduce the browser timezone this module
  // exists to keep out of the comparison.
  const start = startIso.slice(0, 10);
  const today = serverDate.slice(0, 10);
  if (start > today) return 'none';
  if (start === today) return 'in_progress';
  return 'in_progress_backdated';
}

/**
 * The clause to append to a control's label and accessible name, or `null` for none.
 *
 * The past-date case says "backdated" rather than naming `actual_start`: `actual_start`
 * is not a field the affordance shows, and the user-visible consequence is that the
 * task is recorded as having started then. It is deliberately a label rather than a
 * confirm — the gutter drag has committed past dates without one since #336 and no
 * report has come in, so adding a modal here would be a new friction on an old path.
 */
export function startCommitClause(
  startIso: string | null | undefined,
  serverDate: string | null | undefined,
): string | null {
  switch (startCommitEffect(startIso, serverDate)) {
    case 'in_progress':
      return 'also marks this task In progress';
    case 'in_progress_backdated':
      return 'also marks this task In progress, backdated to that day';
    default:
      return null;
  }
}

/**
 * The sentence announced after the write lands, or `null` to keep the caller's.
 *
 * Derived from the task the PATCH actually returned, not from the prediction above.
 * The prediction can only ever be as fresh as the last project fetch; the response is
 * the server saying what it did. A screen-reader user's only evidence that anything
 * happened is this sentence, so the one outcome it must never omit is the one nobody
 * asked for.
 */
export function startCommitAnnouncement(
  committedLabel: string,
  statusBefore: string | null | undefined,
  statusAfter: string | null | undefined,
): string {
  const base = `Committed start set to ${committedLabel}. This task is now on the timeline.`;
  if (statusBefore === 'NOT_STARTED' && statusAfter === 'IN_PROGRESS') {
    return `${base} It is now marked In progress.`;
  }
  return base;
}
