`/api/v1/readyz` now detects migration drift in **both** directions. It previously
compared only the migrations the running image ships against what the database has
applied, so a database carrying migrations the image does not know about — an image
rolled back without restoring the schema — was invisible to it and the pods reported
ready. The response gains a coarse `migration_state` field (`in_sync`, `behind`,
`ahead`, `unknown`); `checks` keeps its existing keys and `ok`/`fail` values, so
probes and scrapers reading only `status`/`checks` are unaffected. `ahead` gates
only a pod that *booted* into it — the rollback case — so a forward rolling
upgrade, which drives every old pod `ahead` the moment the new pod's `migrate`
runs, never pulls those pods out of the Service. `TRUEPPM_READYZ_ALLOW_DB_AHEAD=true`
additionally re-opens the gated case for a classified additive-only rollback,
without hiding the reported state. The upgrade
runbook and the selector docstring, which both claimed the old check already caught
a downgrade, have been corrected: schema presence is not data compatibility, and
rolling back across a destructive migration still requires restoring from backup.
