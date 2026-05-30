---
title: Release Process
description: How to cut a TruePPM release — version bump, changelog, tag, and publish.
---

This page documents the release process for `trueppm-suite`. Releases are created by running `scripts/release.sh` on `main`, which bumps all version manifests, rotates the changelog, commits, and creates an annotated git tag. Pushing the tag triggers the CI publish jobs.

## Prerequisites

Before cutting any release:

1. **All MRs for the milestone are merged.** Check with `glab issue list --milestone <version>`.
2. **`main` pipeline is green.** Releases are cut from a clean, passing `main`.
3. **Changelog fragments are present.** Every user-visible change should have a fragment in `changelog.d/`. Run `bash scripts/assemble-changelog.sh --dry-run` to preview the assembled changelog.
4. **Smoke test passes.**
   ```bash
   make release-smoke
   ```
   This boots the dev stack, seeds the demo project, and curls every shipped endpoint. Fix any failures before proceeding.

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

**Pre-release CHANGELOG behaviour:** Alpha/beta/RC bumps do NOT rotate the `[Unreleased]` section — notes accumulate until the final stable release.

### Confirmation gate

Before any manifest is touched, the script shows the computed version as a **suggestion** and asks you to confirm it. Because every release cuts two immutable tags (`v<semver>` and `scheduler-v<pep440>`), this is the last point at which a wrong stage or a stale base can be caught:

```text
About to cut a release:
  current : 0.1.9
  new     : 0.2.0-alpha.1   <- suggested
  tags    : v0.2.0-alpha.1, scheduler-v0.2.0a1
  note    : pre-release — CHANGELOG will not be rotated
Enter to accept 0.2.0-alpha.1, type an explicit version to override, or 'q' to abort:
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

The `git push origin main v0.2.0` command triggers three CI publish jobs:
- `api:publish` — pushes `ghcr.io/trueppm/api:0.2.0`, `0.2`, and `latest`
- `web:publish` — pushes `ghcr.io/trueppm/web:0.2.0`, `0.2`, and `latest`
- `helm:publish` — packages and pushes the Helm chart to `oci://ghcr.io/trueppm/charts`

Additionally, if you push a `scheduler-v*` tag, `scheduler:publish` publishes `trueppm-scheduler` to PyPI. Scheduler releases are versioned independently (see below).

## Scheduler releases

The scheduler package (`packages/scheduler`) is versioned independently from the rest of the platform. Its tag format is `scheduler-v*` (e.g. `scheduler-v0.2.0`), not `v*`.

```bash
# Bump the scheduler version and push its tag
./scripts/release.sh minor          # bumps all manifests including scheduler
git push origin main scheduler-v0.2.0
```

The `scheduler:publish` CI job fires on `scheduler-v*` tags and publishes to PyPI.

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
| `CHANGELOG.md` | `[Unreleased]` → `[x.y.z] - YYYY-MM-DD` (stable only) |

The Helm chart version in `packages/helm/Chart.yaml` is kept in sync manually — bump `version` and `appVersion` to match before running `release.sh`.

## Troubleshooting

**"Tag vX.Y.Z already exists"** — the tag was already pushed. Check if the CI jobs ran correctly; if the images are already published, no action is needed.

**"Working tree is not clean"** — stash or commit pending changes before running the script.

**"[Unreleased] section is empty"** — add changelog fragments to `changelog.d/` and run `bash scripts/assemble-changelog.sh` to populate `[Unreleased]` before releasing.

**CI publish job fails** — verify `GHCR_TOKEN` and `GHCR_USER` are set in GitLab CI/CD variables (Settings → CI/CD → Variables) and that the PAT has `write:packages` scope.
