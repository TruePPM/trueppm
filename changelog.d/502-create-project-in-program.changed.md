- **Programs — create projects from inside a program**: the Program shell's
  Projects tab now offers two distinct buttons — **New project** (opens the
  project creation wizard prefilled with the current program) and **Add
  existing** (the cross-program picker). Replaces the single ambiguous
  `+ Add project` button that only opened the picker. The `POST /projects/`
  endpoint accepts an optional `program` field at creation time; the server
  enforces ADMIN on the target program (ADR-0070 cross-permission gate).
- **ADR-0070**: clarified the OSS/Enterprise boundary in the Status section —
  the data model is 1 Program → N Projects; users may belong to multiple
  programs (navigation only); no shipped feature aggregates across programs
  (portfolio aggregation remains Enterprise).
