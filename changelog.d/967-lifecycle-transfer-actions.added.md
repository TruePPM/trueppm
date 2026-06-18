- **Project ownership & program sponsorship transfer**: the **Transfer ownership**
  (Project → Settings → Lifecycle) and **Transfer sponsorship** (Program → Settings →
  Lifecycle) actions are now wired. Each opens a member picker and atomically promotes
  the chosen member to Owner while demoting the current Owner to Admin; the program
  flow can optionally rotate the program manager in the same step. The new owner /
  sponsor must already be a project / program member. Both endpoints
  (`POST /api/v1/projects/{id}/transfer/`, `POST /api/v1/programs/{id}/transfer-sponsorship/`)
  are Owner-only and reject non-owners with `HTTP 403`. The remaining two #967 lifecycle
  actions — **Export project** (async portable bundle) and **Split into sub-programs** —
  stay disabled and tracked.
