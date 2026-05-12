Fix CI failure on pre-release builds: widened `trueppm-api`'s dependency
on `trueppm-scheduler` from `>=0.1.0` to `>=0.1.0a0` so pip accepts the
locally-installed pre-release editable. Previously, PEP 440 excluded
`0.1.0-alpha.1` from satisfying `>=0.1.0`, causing every API CI job to
fail with "No matching distribution found" once the version was bumped
to an alpha.
