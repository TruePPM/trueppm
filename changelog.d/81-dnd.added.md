Drag a task onto a summary row in the WBS view to re-parent it
under that summary. An aria-live region announces
`"<Task> will become child of <Summary>"` on hover, and the target
summary highlights with the brand-primary drop-over treatment.
New endpoint: `POST /api/v1/projects/<pk>/tasks/<id>/reparent/`
with `{new_parent_id}` — cycle-safe, renumbers old siblings,
triggers CPM recalculation and a `tasks_restructured` broadcast. (#81)
