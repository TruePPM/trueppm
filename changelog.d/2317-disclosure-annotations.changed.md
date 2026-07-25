Task-detail drawer: the "Related tasks" and "Recurrence" sections now fold behind the
"Add detail" row when a task has neither, completing progressive disclosure — the
Details tab no longer shows any empty section header. Tasks gain two read-only API
fields, `has_related_links` and `has_recurrence`, so the drawer can tell those sections
are empty without fetching their contents.
