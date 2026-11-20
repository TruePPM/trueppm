# Vendored Semgrep rule packs

These YAML files are the resolved Semgrep registry packs used by the
`security:semgrep` CI job (`.gitlab-ci.yml`). They are vendored — not pulled
live from the registry — so that:

- the SAST scan runs **fully offline**, removing registry-fetch latency from the
  CI critical path (it was the pipeline's largest tail-variance source, #1639);
- the exact rules that gate a commit are **pinned and auditable in git**, so a
  registry-side rule change can't fail an otherwise-green MR.

This mirrors how the rest of the repo pins its inputs (image digests, `uv.lock`,
cargo-deny `deny.toml`).

| File          | Registry source              |
|---------------|------------------------------|
| `default.yml` | `p/default` (all languages)  |
| `react.yml`   | `p/react`                    |
| `django.yml`  | `p/django`                   |
| `typescript.yml` | `p/typescript`            |
| `javascript.yml` | `p/javascript`            |

## Refreshing

Do not hand-edit these files. Regenerate them with the script, which re-fetches
each pack from the registry and validates the download:

```bash
scripts/update-semgrep-rules.sh
git add .semgrep && git commit -m "chore(ci): refresh vendored Semgrep rule packs"
```

A scheduled CI job (`semgrep:refresh-mr`, weekly cadence on the nightly
schedule) runs the script and opens an MR with the new packs; see
`docs/harness/flaky-ledger.md`. You can also refresh by hand at any time. The
pack list in the script and the `--config` flags in `.gitlab-ci.yml`
(`security:semgrep`) must stay in lockstep.

## Staleness signal

`.semgrep/REFRESHED` holds the date of the last refresh that changed the packs
(written by the update script; the scheduled job restores it and opens no MR when
upstream is unchanged, so it re-fetches nightly while the stamp is stale). The `lint:semgrep-freshness` CI job reads it: it warns (orange,
`allow_failure`) after 45 days and fails after 90, via
`scripts/check-semgrep-freshness.sh`. A frozen offline pack otherwise reports
clean forever (#3103).
