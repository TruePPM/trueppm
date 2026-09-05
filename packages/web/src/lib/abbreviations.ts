/**
 * Plain-English readings for the abbreviations and codes the UI shows (#2389).
 *
 * One entry per token, imported wherever that token renders. The point of
 * centralizing is not reuse economy — the strings are short — it is that a
 * column header, a card chip and a print layout showing `WBS` must not drift
 * into three different definitions of it. A reader who learns what a token means
 * on one surface has learned it everywhere.
 *
 * Rules for adding one:
 * - Expand the letters *and* say what the thing is for. "Work Breakdown
 *   Structure" alone still leaves a first-time self-hoster none the wiser.
 * - Describe what the number means, not how to feel about it. "Above 1.0 means
 *   ahead of plan" is a reading; "good" is a judgment the data does not support.
 * - Keep it to one sentence. Anything longer wants a docs link, which makes it a
 *   `FieldHelp` popover rather than a tooltip (rule 121).
 */
export const ABBREVIATIONS = {
  WBS: 'Work Breakdown Structure — the outline number showing where this task sits in the project hierarchy',
  DURATION: 'Duration — working days this task takes, excluding non-working days on its calendar',
  // These two say "row", not "task", and that is load-bearing rather than a
  // stylistic preference. Both render on the Schedule outline's column headers,
  // whose every string is swept by the row-vocabulary lock (#3027/#3031): a
  // heading that calls a row a task is a type claim the row does not carry,
  // because the same column also heads phases and milestones. The lock caught
  // exactly this when the float headers first shipped with tooltips, and the
  // right repair was the definition rather than the header — the word is equally
  // wrong on the drawer and the table, where a phase's Float cell was already
  // being explained in terms of a "task". Any entry that a locked surface renders
  // must use `ROW_VOCABULARY`'s neutral noun.
  FLOAT:
    'Float (slack) — working days this row can slip before it moves the project finish date',
  FREE_FLOAT:
    'Free float — working days this row can slip before it delays the row that follows it, which is usually less than its total float',
  CRITICAL:
    'On the critical path — this task has no float, so any slip moves the project finish date',
  EVM: 'Earned Value Management — progress measured in planned cost rather than percent complete',
  CPI: 'Cost Performance Index — earned value divided by actual cost; above 1.0 means under budget',
  SPI: 'Schedule Performance Index — earned value divided by planned value; above 1.0 means ahead of plan',
  UNESTIMATED:
    'No story-point estimate yet — points size the work for velocity and burndown, separately from the duration estimate the schedule uses',
  STORY_POINTS_PURPOSE:
    'points size the work for velocity and burndown, separate from the duration estimate the schedule uses',
} as const;

export type AbbreviationKey = keyof typeof ABBREVIATIONS;
