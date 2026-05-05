---
name: release
description: Cut a TruePPM release — bump versions, rotate changelog, tag, push, and (post-1.0) verify GHCR publish and trigger enterprise release.
disable-model-invocation: true
argument-hint: "<patch|minor|major|alpha|beta|rc|release|x.y.z> [alpha|beta|rc]"
---

# Release

You are creating a release for TruePPM. The heavy lifting lives in `scripts/release.sh` — it handles version bumps across all three packages (`scheduler`, `api`, `web`), changelog fragment assembly, `[Unreleased]` rotation (stable only), commit, and tag. **Do not replicate what the script does manually.** Your job is to run the right pre-flight checks, invoke the script with the right argument, push, and handle post-tag fan-out.

TruePPM ships from a single GitLab repo (`gitlab.com/trueppm/trueppm`). The `github.com/trueppm` org is registered but **empty pre-1.0** — pre-1.0 releases stay on GitLab only. Once `1.0.0` ships, GHCR begins receiving multi-arch (ARM64 + AMD64) images and the scheduler package may begin publishing to PyPI.

## Step 0 — Resolve the bump

`scripts/release.sh` accepts these forms (see the script's header for full reference):

```
Stable:    patch | minor | major
Pre-rel:   minor alpha | minor beta | minor rc        (start a series)
           alpha | beta | rc                          (increment in series)
           release                                    (finalize pre-rel → stable)
Explicit:  x.y.z   or   x.y.z-rc.N
```

If `$ARGUMENTS` is empty, determine the right bump:

1. Read the current version from `packages/scheduler/pyproject.toml` (canonical source).
2. List unassembled changelog fragments: `ls changelog.d/*.md` (excluding `README.md`). Group by type suffix (`.added.md`, `.changed.md`, `.fixed.md`, `.security.md`).
3. Apply these rules:
   - **PATCH** — only `.fixed.md` (and possibly `.security.md`) fragments → e.g. `0.1.0 → 0.1.1`
   - **MINOR** — any `.added.md` or `.changed.md` fragments → e.g. `0.1.0 → 0.2.0`
   - **MAJOR** — any breaking change (removed/renamed API endpoints, changed auth flows, destructive migrations, incompatible config changes, scheduler pip API signature changes once 1.0 has shipped) → e.g. `0.x.y → 1.0.0`
   - **Pre-release** — increment the suffix (`alpha.1 → alpha.2`), promote the stage (`beta.N → rc.1`), or finalize (`rc.N → stable` via `release`)
   - When in doubt between MINOR and MAJOR, prefer MINOR and call out the trade-off explicitly
4. Present the suggested bump command (e.g. "`./scripts/release.sh minor`, projected `0.2.0`") with a one-line rationale and ask the user to confirm before proceeding.

### Valid version formats
- Stable: `MAJOR.MINOR.PATCH` (e.g. `1.2.3`)
- Pre-release: `MAJOR.MINOR.PATCH-<stage>.N` (e.g. `1.2.3-rc.1`)
- Stages in ascending order: `alpha` → `beta` → `rc`
- Pre-release suffix must include a numeric component (`rc.1` not `rc`)

## Step 1 — Pre-flight checks

Before running the script:
- [ ] Confirm `/pre-release full` was run against this milestone and any 🔴 findings are resolved (per CLAUDE.md). If skipped, note that inline.
- [ ] Confirm all open MRs intended for this release are merged into `main`
- [ ] Confirm the working tree is clean (`git status`) and on `main` with the latest pulled (`git fetch origin && git status`)
- [ ] Confirm at least one fragment exists in `changelog.d/` for stable releases (the script will fail otherwise once it assembles and finds `[Unreleased]` empty)
- [ ] Confirm no merge-conflict markers remain anywhere — particularly in `CHANGELOG.md` (`grep -n '<<<<<<< ' CHANGELOG.md`)

## Step 1b — Documentation audit

For every fragment in `changelog.d/`, verify documentation is in sync:

- **`*.added.md` (new features)** — each must have a corresponding page or section in `docs/features/` (or `docs/getting-started/` / `docs/administration/` where appropriate), with the correct version callout (`> **Added in X.Y**`) and enterprise callout if applicable. Run the `docs-writer` skill if anything is missing.
- **API surface changes** — any new or modified endpoint must be reflected in `docs/api/` and `docs/api/openapi.json`. Regenerate the schema if needed: `git merge origin/main && scripts/export-openapi.sh && git add docs/api/openapi.json`. Run the `api-design` skill (audit mode) if anything is missing.
- **Scheduler pip-package surface changes** — any new export, signature change, or behaviour change in `packages/scheduler` must be reflected in the scheduler README and the published docs section. Once 1.0 ships, this surface is locked for the major line.
- **`*.changed.md` (changed behaviour)** — existing doc pages must reflect the new behaviour; stale screenshots or descriptions must be updated.
- **Helm chart changes** — any new value, env var, or default change must be reflected in `packages/helm/values.yaml` comments and in `docs/administration/`.
- **Breaking changes** — if any exist, ensure a migration or upgrade note is present in `docs/getting-started/` or a dedicated upgrade guide.

Do not proceed to Step 2 until the docs audit is complete. A release with stale documentation is worse than no documentation — users will follow the wrong instructions.

## Step 2 — Run the release script

```bash
./scripts/release.sh <bump>
```

The script will automatically:
1. Validate the working tree is clean and the branch is `main`
2. Compute the new version from the canonical source (`packages/scheduler/pyproject.toml`)
3. Bump versions in `packages/scheduler/pyproject.toml`, `packages/api/pyproject.toml`, and `packages/web/package.json` to lockstep
4. For **stable** releases only: assemble `changelog.d/*.md` fragments via `scripts/assemble-changelog.sh`, rotate `[Unreleased]` to `[X.Y.Z] - YYYY-MM-DD`, prepend a fresh `[Unreleased]` block, and delete the consumed fragments
5. For **pre-releases** (alpha/beta/rc): leave `[Unreleased]` and fragments alone — notes accumulate until the final stable release
6. Commit (`chore(release): bump version to X.Y.Z`) and create an annotated tag `vX.Y.Z`

The script **does not push and does not create an MR** — TruePPM tags from `main` directly. Read the printed "Next steps" line for the exact push command. If the script fails, read the error output before taking any action — common failure modes: dirty working tree, not on `main`, empty `[Unreleased]`, or duplicate tag.

## Step 3 — Push the tag

After the script reports success:

```bash
git push origin main vX.Y.Z
```

Pushing the tag triggers the release pipeline. What happens next depends on the version line:

### Pre-1.0 (`0.x.y` and `0.x.y-<pre>.N`)

- The CI pipeline runs full lint/test/build on the release commit.
- A GitLab Release entry is created automatically by the tag push.
- **No GHCR publish** — `github.com/trueppm` is registered but empty pre-1.0 by design.
- **No PyPI publish for scheduler** — pre-1.0 the package is consumed in-tree from `packages/scheduler` only.
- Confirm the GitLab Release shows up at `gitlab.com/trueppm/trueppm/-/releases/vX.Y.Z` and the CHANGELOG section is populated.

### At-or-post-1.0 (`>= 1.0.0`)

In addition to the GitLab Release:

- The CI pipeline builds and pushes multi-arch Docker images (ARM64 + AMD64) to GHCR under `ghcr.io/trueppm/*`. Verify the images appear at `https://github.com/orgs/trueppm/packages` and that both architectures are listed for each tag (`vX.Y.Z`, plus `latest` for stable releases on the highest line).
- For stable releases, the scheduler package may publish to PyPI as `trueppm-scheduler==X.Y.Z`. Verify with `pip index versions trueppm-scheduler` if the publish job ran.
- Stable releases publish docs to `docs.trueppm.com` under the `latest` alias; pre-releases publish under `next`. Verify the docs site shows the new version.
- Trigger the enterprise repo release script pinned to this tag:
  ```bash
  cd ~/repos/trueppm-suite/trueppm-enterprise
  TRUEPPM_OSS_TAG=vX.Y.Z ./scripts/release.sh <its-own-bump>
  ```
  The enterprise repo has its own version line that increments independently. Run its release script only after the OSS tag has been pushed and the GHCR images are verified.

## Step 4 — Post-release verification

- [ ] Confirm `APP_VERSION` (or equivalent) in the running stack reports the new version after a redeploy of the dev compose stack: `make up && curl http://localhost:8000/api/v1/version/`
- [ ] Confirm the GitLab Release page is populated and the CHANGELOG section reads correctly
- [ ] Pre-1.0: confirm no GHCR images were unexpectedly published (the absence is the contract)
- [ ] Post-1.0: confirm GHCR shows ARM64 + AMD64 manifests for `vX.Y.Z` and (if stable + highest line) `latest`
- [ ] Post-1.0: confirm `docs.trueppm.com` reflects the new version under the correct alias
- [ ] Post-1.0: confirm the enterprise release ran cleanly and pins to `TRUEPPM_OSS_TAG=vX.Y.Z`

## Step 5 — Roll-back guidance

If a release tag was pushed and a critical issue surfaces post-tag:

- **Pre-1.0** — prefer cutting the next patch (`./scripts/release.sh patch`) with the fix. Only delete the tag if no consumers have pulled it (typically only true within minutes of push). To delete: `git tag -d vX.Y.Z && git push --delete origin vX.Y.Z`. Confirm with the user before any destructive tag operation.
- **At-or-post-1.0** — never delete a tag once GHCR images have published or the enterprise release has pinned to it. Cut a patch release with the fix instead. The previous tag remains visible in history; the patch supersedes it for users.
