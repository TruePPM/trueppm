- **Schedule task-ceiling warnings**: the CSV/Excel import preview now warns
  (without blocking) when committing the import would carry a project past the
  Schedule's tested-comfortable size (~1,000 tasks) — naming the projected task
  count and linking the deployment sizing guide. Opening the Schedule on a
  project already past that line shows the same warning as a dismissible
  banner, computed from the already-loaded task list with no extra request.
  Both are pure UI: nothing is measured or transmitted anywhere.
