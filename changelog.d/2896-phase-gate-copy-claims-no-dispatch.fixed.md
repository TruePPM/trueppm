The program Cadence settings screen no longer claims capabilities the product
does not have. It stated that gate reviews are scheduled automatically when a
phase boundary milestone is saved, that ceremony instances are created when the
program starts and linked to milestones, and that the invite template supports
`{{milestone.name}}`-style variables. None of that happens: `PhaseGateConfig` and
`CeremonyTemplate` are both config-only, `invite_template` is read by no code,
there is no ceremony instance model, and nothing substitutes a placeholder. A PM
could configure phase gates, believe a review was booked, and find out in the
room — a claimed compliance control is worse than an admitted gap, because only
the admitted gap can be planned around.

The page subtitle, the section copy, and the slide-over now describe storage and
say what you still have to do yourself, and the caveat is bound to the button
that opens the panel so it reaches screen-reader users too. The program settings
documentation matches. Dispatch is tracked as #2983.
