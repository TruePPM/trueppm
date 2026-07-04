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

## Refreshing

Do not hand-edit these files. Regenerate them with the script, which re-fetches
each pack from the registry and validates the download:

```bash
scripts/update-semgrep-rules.sh
git add .semgrep && git commit -m "chore(ci): refresh vendored Semgrep rule packs"
```

Refresh on a documented cadence — e.g. once per dot-release, alongside the
dependency and image-digest refresh — to pick up upstream rule improvements. The
pack list in the script and the `--config` flags in `.gitlab-ci.yml`
(`security:semgrep`) must stay in lockstep.
