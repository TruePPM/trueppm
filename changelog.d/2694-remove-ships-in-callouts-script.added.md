- **Release-time removal of stale "Ships in 0.X" docs callouts**: added
  `scripts/remove-ships-in-callouts.sh`, which finds and removes the
  `:::note[Ships in 0.X]` / `:::caution[Ships in 0.X]` / `Coming in 0.X`
  fenced callout blocks that mark docs pages as describing an unreleased
  feature, once that version actually ships. It refuses to run for a
  version not yet listed under the roadmap's "## Shipped" section, supports
  `--dry-run` (default) and `--apply`, and is now wired into
  `scripts/release.sh` so this no longer has to be done by hand at release
  time. Non-fenced occurrences (headings, inline prose) are flagged for
  manual review rather than guessed at.
