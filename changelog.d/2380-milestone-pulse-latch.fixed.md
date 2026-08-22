A `#task-<id>` deep link to a milestone no longer positions its pulse animation at
an invalid coordinate when the target's date cannot be parsed. The guard was a
`try`/`except` commented "dateToLeft can throw on out-of-range dates" — it cannot
throw, so the case it claimed to handle fell straight through and the pulse was
placed at `NaN`. It now checks the value instead of waiting for an exception that
never comes.

The pulse also records which milestone it fired for in a `data-pulsed-task-id`
attribute that outlives the 1.5-second animation, so the behavior can be verified
without racing the animation itself.
