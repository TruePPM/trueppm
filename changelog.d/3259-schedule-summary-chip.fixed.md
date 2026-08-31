**The Schedule's summary chip no longer calls every row a task, and now says how
much of the plan is running in sprints.** It read `{N} tasks · {C} critical ·
CPM ✓`, deriving `N` from every visible row regardless of type — so a plan of
phases and milestones was announced as that many "tasks". The chip now reads
`{N} items · {S} in sprints · {C} critical · CPM ✓`, taking its noun from the
row vocabulary rather than a literal.

`{S} in sprints` is the readout that was supposed to arrive when the Mode column
was removed and never did, leaving a hybrid plan with nowhere on the Schedule to
say how much of itself runs iteratively. It excludes phase summaries, matching
the critical count, and **follows the project's configured iteration label** —
a team running Iterations or PIs sees `3 in iterations` / `3 in PIs`, not
"sprints".

When the toolbar tightens, `in sprints` is the first token dropped, ahead of
`critical`: the critical count drives the plan's dates, the sprint count
describes how it is being run. The spoken form is unaffected — the accessible
name carries all four counts at every width.

The vocabulary lock (`rowVocabularyLock.test.tsx`) now renders this chip, in
both of its noun-bearing states. This was the lock's first real miss: two hand
sweeps and then the mechanism built to replace them all passed over the file
because nothing rendered it. Fixing the string without adding it to the roster
would have left the next chip exactly as unprotected.

Closes #3259
