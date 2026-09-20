- **`trueppm_mcp.__version__` was a hand-maintained literal**: found via regression-check
  while fixing the identical defect in `trueppm-api` — it worked today only because it
  happened to be updated for this release, and would have gone stale on the next one the
  same way. Now reads installed package metadata, matching `trueppm-scheduler`'s pattern.
