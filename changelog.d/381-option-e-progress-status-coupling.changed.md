When a task hits 100% progress, status now flips automatically based on
the actor's role: PMs and PMOs land in COMPLETE; contributors (Team
Member, Resource Manager, Viewer) land in REVIEW so a sign-off step is
preserved without a separate "review pending" tag. The Review *column*
itself is the governance gate — VoC 2026-05-08 (Option E). REVIEW now
also clamps `percent_complete` to 100 on save, mirroring COMPLETE,
because both states semantically mean "work delivered" — only sign-off
status differs. Backfill migration 0030 patches existing
`status=REVIEW, progress<100` rows.
