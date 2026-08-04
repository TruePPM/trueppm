- **CSV import indent-depth DoS**: an extreme indent depth (leading whitespace/dots
  in a task name, or a huge bare-digit WBS column value) could produce a WBS path
  that exceeded the database's hierarchy-path limit, crashing the import silently
  and leaving it stuck retrying forever. Depth is now capped during parsing, and
  any unexpected import failure now fails the request visibly instead of looping.
