**`backup.enabled=true` no longer produces zero backups while reporting success.**
With no destination configured the `backups` volume fell back to an `emptyDir`:
the Job dumped, exited 0, the artifact died with the pod, and the CronJob
reported success forever. The chart now refuses to render that combination and
names the four ways to give it a destination. Enabling backups (with
`alerts.enabled`) also ships `TruePPMBackupJobFailed`, `TruePPMBackupStale`, and
`TruePPMBackupNeverSucceeded`, plus a `TruePPMVolumeFillingUp` rule covering
every claim in the namespace — the CronJob template's own comment had promised a
failed Job "the operator can alert on" while nothing shipped to do that. The
CronJob's inline command has also been brought back into line with
`scripts/backup.sh`: its `tar` no longer swallows failures with `|| true`, and
its `MANIFEST` carries the same seven fields, so a restorer can tell whether
media is inside the artifact they are holding. The CI restore drill now extracts
that command from the render and round-trips it through `restore.sh`, which it
had previously only ever triggered on. Closes #3185.
