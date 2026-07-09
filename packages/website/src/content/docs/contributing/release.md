---
title: Release Process
description: How to cut a TruePPM release — version bump, changelog, tag, and publish.
---

This page documents the release process for `trueppm-suite`. Releases are created by running `scripts/release.sh` on `main`, which bumps all version manifests, rotates the changelog, commits, and creates an annotated git tag. Pushing the tag triggers the CI publish jobs.

## Prerequisites

Before cutting any release:

1. **All MRs for the milestone are merged.** Check with `glab issue list --milestone <version>`.
2. **`main` pipeline is green.** Releases are cut from a clean, passing `main`.
3. **Changelog fragments are present.** Every user-visible change should have a fragment in `changelog.d/`. Run `cat changelog.d/*.md` to preview the pending entries. (Do not run `scripts/assemble-changelog.sh` to preview — it assembles for real, consuming the fragments and rewriting `CHANGELOG.md`; the release script invokes it at the right moment.)
4. **Smoke test passes.**
   ```bash
   make release-smoke
   ```
   This boots the dev stack, seeds the demo project, and curls every shipped endpoint. Fix any failures before proceeding.
5. **Version-tense alignment.** Diff the docs under `packages/website/src/content/docs/` against `overview/roadmap.md` (the single source of truth) for version-tense drift: every version mentioned in past/present tense must be under the roadmap's **## Shipped** section; anything under **Underway** or **Planned** must read in future tense. Run `bash scripts/check-version-status.sh` (the same gate the `docs:version-accuracy` CI job runs). When this release tags, move it to the roadmap's **## Shipped** section and bump `SHIPPED` in `src/content/_release-status.mdx` so the prose tense for the new release becomes legal.
6. **Migrations are squashed (minor boundaries only).** At each `0.x → 0.(x+1)` minor cut — not for patch/alpha/beta/RC bumps within a series — collapse each app's migration history with Django's non-destructive `replaces=` squash (`python manage.py squashmigrations <app> <start> <end>`), per the migration-discipline rules in the root `CLAUDE.md` (rule 6). The originals stay on disk, so fresh installs use the collapsed migration while existing databases upgrade as a no-op — never hand-write a regenerated `0001_initial`, which cannot reproduce the non-regenerable ops (ltree/pg_trgm extensions, the GiST `wbs_path` index, the `historicaltask` composite index). After squashing, run `ruff check --fix <migrations> && ruff format <migrations>` and confirm `python manage.py makemigrations --check --dry-run` reports *No changes detected*. Any deferred per-app squash work is tracked in the milestone issue for the cut (e.g. #1360 for 0.4).
7. **Docs version is cut (minor boundaries only).** At each `0.x → 0.(x+1)` minor cut — **starting with 0.4**, the first frozen version — freeze the shipped docs as a [`starlight-versions`](https://github.com/HiDeoo/starlight-versions) snapshot, so users on the released version keep accurate docs while the live site tracks the next release as "Next (unreleased)". After prerequisite 5 has bumped the release-status SSOT to the new version, edit `packages/website/astro.config.mjs` to add the entry to the `versions` array (e.g. `{ slug: "0.4", label: "v0.4" }`), run `npm run build` in `packages/website` once so the plugin archives the current docs tree into `src/content/docs/<version>/`, then commit the generated snapshot. Not done for patch/alpha/beta/RC bumps within a series. The full recipe lives in the comment above `const versions` in `astro.config.mjs`.

## Version scheme

TruePPM follows [semantic versioning](https://semver.org/). The script manages both stable and pre-release series:

| Command | Example | Result |
|---------|---------|--------|
| `./scripts/release.sh patch` | `0.1.0 → 0.1.1` | Bugfix release |
| `./scripts/release.sh minor` | `0.1.0 → 0.2.0` | New features, backwards-compatible |
| `./scripts/release.sh major` | `0.1.0 → 1.0.0` | Breaking changes |
| `./scripts/release.sh minor alpha` | `0.1.0 → 0.2.0-alpha.1` | Start alpha series |
| `./scripts/release.sh alpha` | `0.2.0-alpha.1 → 0.2.0-alpha.2` | Next alpha |
| `./scripts/release.sh beta` | `0.2.0-alpha.2 → 0.2.0-beta.1` | Promote to beta |
| `./scripts/release.sh rc` | `0.2.0-beta.1 → 0.2.0-rc.1` | Promote to RC |
| `./scripts/release.sh release` | `0.2.0-rc.1 → 0.2.0` | Finalize pre-release |
| `./scripts/release.sh 1.2.3` | explicit | Pin to specific version |

**Pre-release CHANGELOG behavior:** Alpha/beta/RC bumps do NOT rotate the `[Unreleased]` section — notes accumulate until the final stable release.

### Confirmation gate

Before any manifest is touched, the script shows the computed version as a **suggestion** and asks you to confirm it. Because every release cuts two immutable tags (`v<semver>` and `scheduler-v<pep440>`), this is the last point at which a wrong stage or a stale base can be caught:

```text
About to cut a release:
  current : 0.2.0-alpha.1
  new     : 0.3.0-alpha.1   <- suggested
  tags    : v0.3.0-alpha.1, scheduler-v0.3.0a1
  note    : pre-release — CHANGELOG will not be rotated
Enter to accept 0.3.0-alpha.1, type an explicit version to override, or 'q' to abort:
```

- **Enter** accepts the suggested version.
- **Type an explicit semver** (e.g. `0.2.0-beta.1`) to override — the prompt re-displays with the new version and its tags so you re-confirm before proceeding.
- **`q`** aborts without writing anything.

Pass `-y` / `--yes` (or set `RELEASE_ASSUME_YES=1`) to accept the computed version without the prompt — required for non-interactive runs, which otherwise **fail closed** rather than auto-cut a tag:

```bash
./scripts/release.sh minor --yes        # accept the computed 0.2.0 non-interactively
```

## Step-by-step: stable release

```bash
# 1. Ensure you're on a clean, up-to-date main
git checkout main && git pull origin main
git status              # must be clean

# 2. Verify the milestone is complete
glab issue list --milestone 0.2   # should return 0 open issues

# 3. Run the smoke test
make release-smoke

# 4. Cut the release
./scripts/release.sh minor        # e.g. 0.1.0 → 0.2.0

# 5. Review the generated commit and tag
git log --oneline -3
git show v0.2.0 --stat

# 6. Push — this triggers the CI publish jobs
git push origin main v0.2.0
```

The `git push origin main v0.2.0` command triggers the CI **publish stage**:
- `api:publish` — builds the API Docker image and pushes `$CI_REGISTRY_IMAGE/api:v0.2.0` and `latest` to the GitLab container registry; if `GHCR_USER`/`GHCR_TOKEN` are set it also pushes `ghcr.io/<user>/api:0.2.0` and `latest`
- `web:publish` — same as above for the web image (`$CI_REGISTRY_IMAGE/web`, optional GHCR mirror)
- `helm:publish` — packages and pushes the Helm chart to `oci://ghcr.io/<user>/charts` (skipped without GHCR credentials)
- `api:publish:pypi` — publishes `trueppm-api` to PyPI (skipped without `PYPI_TOKEN`)
- `web:publish:npm` — publishes `@trueppm/web` to npm (skipped without `NPM_TOKEN`)
- `release:create` — creates the GitLab release entry

The GitLab container registry is the primary target (runner credentials are injected automatically); GHCR is an optional mirror — when `GHCR_USER`/`GHCR_TOKEN` are not set, the GHCR push is silently skipped, not failed.

Additionally, pushing the `scheduler-v*` tag triggers `scheduler:publish`, which publishes `trueppm-scheduler` to PyPI.

## Scheduler releases

The scheduler package (`packages/scheduler`) is released **in lockstep** with the rest of the platform: `scripts/release.sh` bumps all manifests to the same version and creates both tags in one run. The same version is translated to PEP 440 for the scheduler's `scheduler-v*` tag (e.g. `0.2.0-alpha.1` → `scheduler-v0.2.0a1`).

```bash
# One release run produces both tags
./scripts/release.sh minor          # bumps all manifests including scheduler
git push origin main v0.2.0 scheduler-v0.2.0
```

The `scheduler:publish` CI job fires on `scheduler-v*` tags and publishes to PyPI.

### PyPI Trusted Publishing (one-time setup)

`scheduler:publish` authenticates to PyPI via **Trusted Publishing** (GitLab OIDC) — there is no static `PYPI_TOKEN` on the publish path. The job presents a short-lived GitLab ID token that PyPI exchanges for a single-use, project-scoped upload token. For that exchange to succeed, a **Trusted Publisher must be registered on the PyPI project** whose claims match this pipeline exactly. This is a **one-time PyPI-side configuration** — do it **before the first `scheduler-v*` tag** that uses OIDC, or the `mint-token` step fails `HTTP 422` before anything is uploaded.

On PyPI → `trueppm-scheduler` → **Manage → Publishing → Add a new publisher (GitLab)**:

| Field | Value |
|---|---|
| Namespace | `trueppm` |
| Project name | `trueppm` (the repo is `trueppm/trueppm`) |
| Top-level pipeline file path | `.gitlab-ci.yml` |
| Environment name | **blank** — `scheduler:publish` sets no `environment:`; a non-blank value here makes the OIDC claims mismatch and itself returns 422 |

The values must match the running job: namespace/project come from the repo path (`gitlab.com/trueppm/trueppm`), and the environment must be left blank because the job declares no `environment:`. After registering the publisher, **retry `scheduler:publish` on the existing tag** — no re-tag is needed; the job rebuilds from the tag and the fix is purely PyPI-side.

When a future package is migrated from a static token to OIDC, complete this PyPI-side registration as part of the migration, not after the first failed tag.

## Enterprise release

After pushing the OSS tag, run the enterprise release script in `trueppm-enterprise`:

```bash
cd ../trueppm-enterprise
./scripts/release.sh --oss-tag v0.2.0
```

The enterprise script pins `TRUEPPM_OSS_TAG` to the OSS release and bumps the enterprise version independently.

## Hotfix procedure

For a critical fix on an already-released version:

```bash
# Branch from the release tag
git checkout -b fix/critical-bug v0.1.0

# Apply the fix, commit, open an MR back to main
# After the MR merges to main, cherry-pick or re-cut as a patch release:
git checkout main && git pull origin main
./scripts/release.sh patch          # 0.1.0 → 0.1.1
git push origin main v0.1.1
```

## What the script modifies

| File | Change |
|------|--------|
| `packages/scheduler/pyproject.toml` | `version = "x.y.z"` |
| `packages/api/pyproject.toml` | `version = "x.y.z"` |
| `packages/web/package.json` | `"version": "x.y.z"` |
| `packages/api/src/trueppm_api/settings/base.py` | `SPECTACULAR_SETTINGS["VERSION"]` set to the base semver (pre-release suffix stripped) |
| `docs/api/openapi.json` | Regenerated via `scripts/export-openapi.sh` so the committed schema matches the tag |
| `CHANGELOG.md` | `[Unreleased]` → `[x.y.z] - YYYY-MM-DD` (stable only) |

The Helm chart version in `packages/helm/Chart.yaml` is kept in sync manually — bump `version` and `appVersion` to match before running `release.sh`.

## Troubleshooting

**"Tag vX.Y.Z already exists"** — the tag was already pushed. Check if the CI jobs ran correctly; if the images are already published, no action is needed.

**"Working tree is not clean"** — stash or commit pending changes before running the script.

**"[Unreleased] section is empty"** — add changelog fragments to `changelog.d/` and run `bash scripts/assemble-changelog.sh` to populate `[Unreleased]` before releasing.

**`scheduler:publish` fails `HTTP 422` at the `mint-token` step** — PyPI has no Trusted Publisher matching the pipeline's OIDC claims (it builds and signs the wheel correctly, then fails *before* any upload, so nothing is published). Register the publisher as described in [PyPI Trusted Publishing](#pypi-trusted-publishing-one-time-setup) above, then retry the job on the existing tag — no re-tag needed. The job prints PyPI's exact reason from the 422 response body to the log, so read it to confirm the mismatched claim (most often a non-blank environment name).

**`scheduler:publish` fails `InvalidDistribution: ... has no associated attestations`** — `twine --attestations` is an opt-in gate, not filesystem discovery: it only attaches `.publish.attestation` sidecars that are passed to it as explicit arguments. The `twine upload` command must list the sidecars (`dist/*.publish.attestation`) alongside the dists, or it rejects the upload before anything is published. (Fixed in #1390.)

**CI publish job fails** — the failure is in the build or push itself (Docker build error, registry outage, expired credentials), so read the job log. Note that *missing* `GHCR_TOKEN`/`GHCR_USER` (or `PYPI_TOKEN`/`NPM_TOKEN`) does **not** fail the job — those publishes are silently skipped with an `INFO` log line and the job exits 0. If a GHCR image you expected never appeared, check that both variables are set in GitLab CI/CD variables (Settings → CI/CD → Variables) and that the PAT has `write:packages` scope.
