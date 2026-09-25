---
name: release
model: sonnet
description: Cut a TruePPM release — bump versions, rotate changelog, tag, push, and verify GHCR publish (live pre-1.0 as of 0.4, #939) and (post-1.0) trigger enterprise release.
disable-model-invocation: true
argument-hint: "<0.4 beta 4 | x.y.z[-stage.N] | patch|minor|major|alpha|beta|rc|release [alpha|beta|rc]>"
---

# Release

You are creating a release for TruePPM. The heavy lifting lives in `scripts/release.sh` — it handles version bumps across every package manifest, changelog fragment assembly, `[Unreleased]` rotation (every release, pre-releases included), commit, and tags. **Do not replicate what the script does manually.** Your job is to run the right pre-flight checks, invoke the script with the right argument, push, and handle post-tag fan-out.

TruePPM ships from a single GitLab repo (`gitlab.com/trueppm/trueppm`). **GHCR publish is live pre-1.0, as of the 0.4 beta (#939)** — `github.com/trueppm` was registered-but-empty through 0.3, but every release tag from 0.4 onward publishes public `api`/`web` images and the Helm chart to GHCR (multi-arch `linux/amd64` + `linux/arm64` from `v0.4.0-beta.4` on, #3407; `v0.4.0-beta.1`–`.3` were amd64 only — this timing has now moved twice, so verify against `.gitlab-ci.yml` rather than this sentence). See Step 3's "Pre-1.0" section for the current mechanics and how to re-verify the policy hasn't drifted again.

> **Who invokes this.** `/release` is **user-invoked only** (`disable-model-invocation: true`) — cutting a tag is the most side-effectful operation in the repo and must be triggered by a human. The agent cannot call it through the Skill tool; it runs `scripts/release.sh` and the pre-flight/fan-out steps below directly when asked to help cut a release. Same split as `/mr` and `/fix-mr`.

## Step 0 — Resolve the bump

`scripts/release.sh` accepts these forms (see the script's header for full reference):

```
Stable:    patch | minor | major
Pre-rel:   minor alpha | minor beta | minor rc        (start a series)
           alpha | beta | rc                          (increment in series)
           release                                    (finalize pre-rel → stable)
Explicit:  x.y.z   or   x.y.z-rc.N
```

### The user named the target: `/release 0.4 beta 4`

This is the normal way a cut is started, and it means **"cut exactly `0.4.0-beta.4`"**. Normalize the words to the explicit semver and pass *that* to the script, never a bump keyword. The user stated the result, so do not re-derive it:

| `$ARGUMENTS` | Explicit version |
|---|---|
| `0.4 beta 4`, `0.4.0 beta 4`, `0.4.0-beta.4` | `0.4.0-beta.4` |
| `0.5 alpha 1` | `0.5.0-alpha.1` |
| `0.4 rc 1` | `0.4.0-rc.1` |
| `0.4`, `0.4.0`, `0.4 stable` | `0.4.0` |

Then check it is the **next** version, not just a valid one. Read the current version from `packages/api/pyproject.toml` (the script's canonical source) and the latest `v*` tag (`git tag --list 'v*' --sort=-v:refname | head -1`). The target must be exactly one step after the current version: the next number in the same stage (`beta.3 → beta.4`), `.1` of a later stage (`beta.N → rc.1`), or the stable finalize (`rc.N → 0.4.0`). If it skips a number, repeats an existing tag, or goes backwards, **stop and say so**. Do not "fix" it to the nearest valid version.

In this mode you ask the user nothing further about the version. The two remaining human checkpoints are the release **summary** (Step 2) and any 🔴 pre-flight failure (Step 1).

### No arguments

If `$ARGUMENTS` is empty, determine the right bump:

1. Read the current version from `packages/api/pyproject.toml` (the script's canonical source; the scheduler and mcp manifests carry the PEP 440 form of the same version).
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

### Manifests already bumped by a prep commit

Check for this **before** computing anything: `git log --oneline --all | grep -iE "bump.*(main )?release version to|retarget.*publish"` near the version you intend to cut. The version manifests are sometimes bumped ahead of the tag by a deliberate, separate prep commit (message pattern: "bump main release version to X.Y.Z", "retarget `<pkg>` publish to X.Y.Z", explicitly noting "no tag is cut here — that is the release step").

If the manifests already read the version you intend to tag, **do not pass a bump keyword** — `compute_new_version` works off the *current* version and will bump again (e.g. `beta` on an already-`0.4.0-beta.1` tree produces `0.4.0-beta.2`, silently skipping the `beta.1` tag that was actually wanted). Pass the **explicit version** instead: `./scripts/release.sh 0.4.0-beta.1`. `bump_manifest` verifies the current value before writing and is a safe no-op when the manifest already matches, so this just performs the changelog assembly, commit, and tag around the version that's already there.

## Step 1 — Pre-flight checks

Before running the script:
- [ ] Confirm `/pre-release full` was run against this milestone and any 🔴 findings are resolved (per CLAUDE.md). If skipped, note that inline.
- [ ] Confirm all open MRs intended for this release are merged into `main`
- [ ] Confirm the working tree is clean (`git status`) and on `main` with the latest pulled (`git fetch origin && git status`)
- [ ] Confirm at least one fragment exists in `changelog.d/` for stable releases (the script will fail otherwise once it assembles and finds `[Unreleased]` empty)
- [ ] Confirm no merge-conflict markers remain anywhere — particularly in `CHANGELOG.md` (`grep -n '<<<<<<< ' CHANGELOG.md`)
- [ ] Confirm `GHCR_USER`/`GHCR_TOKEN` CI/CD variables **exist AND are actually reachable by the tag you're about to push.** Existence alone is not enough: `glab api "projects/:id/variables"` will show them as `protected: true` — and a protected variable is withheld from any job whose ref isn't a **Protected Tag** (Settings → Repository → Protected tags), full stop, even if the variable is configured correctly. This is exactly what happened at the 0.4.0-beta.1 cut: `scheduler-v*` was protected, `v*` wasn't, so `v0.4.0-beta.1` triggered `api:publish`/`web:publish`/`helm:publish` with `GHCR_USER`/`GHCR_TOKEN` silently empty — three failed jobs, discovered only from the pushed tag's pipeline. Check `glab api "projects/:id/protected_tags"` and confirm a pattern there covers **every** tag scheme a protected variable's job needs: `v*`, `scheduler-v*`, `mcp-v*`. If one is missing, add it now (`glab api "projects/:id/protected_tags" --method POST -f "name=<pattern>" -f "create_access_level=40"` — Maintainers, matching the existing patterns) — cheaper before the tag than after. See Step 3.
- [ ] The same existence-isn't-enough trap applies to any credential scoped by more than a name: `trueppm-mcp`'s first-ever PyPI Trusted Publisher binding (Step 3) is scoped to the `pypi-mcp` **environment**, not just the project — a publisher that exists but is bound to the wrong (or no) environment fails at PyPI's mint-token step exactly like a missing credential would, with a similarly generic-sounding error. When a human confirms "that's set up," verify the *binding* matches what the job actually presents (environment name, workflow file, namespace/project) rather than taking "it's set up" as sufficient on its own.
- [ ] **Prove `api:publish:pypi`'s Trusted Publisher before any tag depends on it.** A PyPI upload cannot be redone, so a misbound publisher burns the version number. `ci:pypi-mint-probe` (#3992) runs the real job's build, attestation signing and OIDC mint-token exchange, then stops before the upload. Look for a successful `api:publish:pypi` on the previous `v*` tag's pipeline. If there is none, or the job's `image` / `id_tokens:` / `environment:` changed since, run `glab ci run -b main --variables PYPI_PROBE:1` and wait for `ci:pypi-mint-probe` to succeed. The probe also decodes the minted token and fails unless its project scope names `trueppm-api` (pinned in `scripts/pypi-project-ids.json`), because a mint can succeed against a publisher registered on the wrong project (#4045). A failure prints PyPI's own reason and blocks the cut. When any publish job's `environment:` or `id_tokens:` changed, still ask the person to confirm the publisher binding on pypi.org (Manage > Publishing shows project, workflow and environment); the probe covers `trueppm-api` only, not `trueppm-mcp` or `trueppm-scheduler`. `scheduler:publish` and `mcp:publish` need the same proof only when their publish config changed since their last green tag.
- [ ] **Inventory every tag-only job that changed since the last tag.** A tag pipeline runs `.gitlab-ci.yml` as it stood at the tag commit, and these jobs run nowhere else. So a job edited since the previous `v*` tag has never run in its current form. Every cut from 0.3.0-alpha.1 through 0.4.0-beta.2 found at least one such defect by burning a version: `api:publish` three times in 0.3, `helm:publish` at beta.1, and the missing main-green gate that turned beta.2 into beta.3. List the changed tag-gated jobs with `git diff <previous v* tag>..HEAD -- .gitlab-ci.yml`, then read the hunks for jobs using `rules-release-tag` or `$CI_COMMIT_TAG`: `*:publish*`, `release:create`, `tag:wait-for-main`, `scheduler:release`, `mcp:release`, `pages`. For each one, either note it is already exercised on every MR (`helm:publish` by `ci:helm-publish-dry-run`, the PyPI build half by `ci:pypi-build-dry-run` — only the credentialed push/sign/mint remains unproven) or run the probe that covers it (`PYPI_PROBE:1` → `ci:pypi-mint-probe`, `ARM64_SMOKE:1` → `ci:arm64-smoke`, `MANIFEST_PROBE:1` → `ci:manifest-probe` / `ci:amd64-smoke`), or name it to the user as **unproven until the tag**. Watch those jobs first in Step 3, and warn that a re-cut is possible. A changed `environment:` or `id_tokens:` also changes which PyPI Trusted Publisher binding the job presents. Confirm the binding on pypi.org, not just the YAML.
- [ ] **Days and commits since the last `v*` tag.** If the line has gone about four weeks, or ~800+ non-merge commits, without a tag, say so in the release summary conversation. A cut that large is carrying untested publish changes *and* a big change surface at once (0.4.0-beta.1: 79 days, 2,458 commits, first-cut publish failure). This is informational: it doesn't block the cut, it sets expectations.
- [ ] Confirm `main`'s pipeline for the commit you will release from is **green**, not running: `glab api "projects/trueppm%2Ftrueppm/pipelines?ref=main&sha=$(git rev-parse HEAD)"`. The release commit lands on top of it, and `tag:wait-for-main` refuses to publish from a commit whose own `main` pipeline is not green.
- [ ] Confirm Docker is running (`docker info`) and `uv` is installed (`uv --version`) — `scripts/release.sh` builds and Trivy-scans the api image before touching any manifest, and re-locks three `uv.lock` files.
- [ ] `source packages/api/.venv/bin/activate` in the shell you'll run `make pre-push` / `scripts/release.sh` from. Homebrew's `mypy` ahead of the venv's on `PATH` produces spurious `redundant-cast`/`unused-ignore` errors on `packages/api/src/trueppm_api/core/valkey.py` — this reproduces on a clean `main` checkout too, so it's an environment artifact, not a real failure, but it will fail `api-typecheck` (and therefore `make pre-push`) until the venv's `bin` comes first. The repo's `pre-push` git hook needs this same activation in its own invoking shell — `git push` from an unactivated shell re-fails the identical way even after a manual `make pre-push` passed.
- [ ] If the target milestone has its own launch-checklist issue (search issue titles in that milestone for "launch-gate checklist" / "release checklist"), read it. Its checkboxes are usually launch-*day* actions (image publish, a hosted-demo deploy, a registry submission) that happen *after* the tag, not blockers for cutting it — but verify every sub-issue it names as a **tag** blocker is actually closed, not just assumed closed, and that anything still open was deliberately re-milestoned or labeled `release::stretch` rather than silently dropped.

## Step 1a — Roadmap maturity promotion (when this release crosses one)

`packages/website/src/content/docs/overview/roadmap.md` states its own rule (CLAUDE.md "Version-status tense"; the roadmap's own `## Shipped` callout): a version moves into `## Shipped` the instant the release line reaches the maturity that version *promises* — the first alpha for a line that promises alpha, the first beta for a line that promises beta, and so on. Check this **before** Step 2: does `NEW_VERSION`'s `### <major>.<minor>` section currently sit under `## Underway` or `## Planned`? If so, this release promotes it, and the promotion has to happen *before* `scripts/release.sh` runs — the script itself never touches roadmap section headings.

**This is not optional and not deferrable, and the two halves cannot be split across separately-timed MRs.** `scripts/check-version-status.sh` is a hard-blocking gate in `make pre-push` and in CI (`docs:version-accuracy`, no `allow_failure`), on every MR and every `main` push. The instant the roadmap says a version is Shipped, every `:::note[Ships in 0.X]` / `:::caution[Ships in 0.X]` / `## Coming in 0.X` callout for it becomes a violation — so the promotion and the callout cleanup that makes those claims true again must land in the *same commit sequence*. Promoting first and cleaning up later (even minutes later, in a second MR) leaves `main` red in between.

### Procedure (one branch, one MR, held for the tag)

1. Branch from clean `main`: `docs/0.X-tense-flip-tag-coincident` (matches the 0.3 precedent, !844 / `01049fe31`).
2. In `roadmap.md`: move the `### 0.X` section from `## Underway`/`## Planned` to immediately after the last `## Shipped` entry. Relocate the `## Underway` heading (and its one paragraph of prose, carried over verbatim) to precede the next release; if a `## Planned` heading no longer has anything between it and `## Underway`, move it to precede the release after that. Update the promoted section's header parenthetical from `(target: ...)` to `(alpha|beta|rc: <actual date>)` and add a `Shipped as the **X.Y.Z** ... Everything below is in main and tagged.` sentence, matching the 0.1/0.2/0.3 sections' style exactly. Leave every *other* heading's text unchanged — pages elsewhere in the docs tree link to some of them by exact slug.
3. Run `bash scripts/remove-ships-in-callouts.sh <0.X> --apply` — mechanically strips every `:::note[Ships in 0.X ...]` / `:::caution[Ships in 0.X ...]` fenced block for that version (dozens to low hundreds of pages by 0.4+). Preview with a dry run first if you want to see the scope.
4. Hand-fix what the script cannot, by design or by miss:
   - `README.md` — always excluded (outside the docs scan root, and outside `check-version-status.sh`'s scan root in either direction, so nothing catches drift there automatically). Grep it for the version and rewrite every future-tense claim by hand.
   - A fenced block whose bracket text spans multiple lines, or whose phrasing doesn't start with the literal `Ships in 0.X` (e.g. `:::note[This whole section ships in 0.4]`) — the exact-string matcher misses these silently, with no FLAG output either. Re-run `bash scripts/check-version-status.sh` after step 3 and hand-fix every `:::note`/`:::caution` it still flags.
   - An inline "Ships in 0.X" inside ordinary prose or a table cell — reported by `check-version-status.sh` but out of `remove-ships-in-callouts.sh`'s scope entirely (never even FLAGged). Fix each by hand (usually just "Ships in" → "Added in").
   - A non-fenced `## Coming in 0.X (...)` heading, or "**Coming in 0.X**" inline prose — `remove-ships-in-callouts.sh --apply` FLAGs these (never auto-removes). Rewrite the heading/sentence to present tense.
   - Sidebar badges: drop the matching `badge: { text: "0.X", ... }` entries in `packages/website/astro.config.mjs` for every `getting-started/` page whose badge just lost its pairing — `check-version-status.sh` checks the badge/`documentedFor` pairing in both directions and flags a badge left behind after its callout is gone.
5. **A page whose feature depends on something outside this repo (a hosted demo, an external registry listing) may still not be true at the tag.** Don't fabricate that it's live to satisfy the gate. Split the page instead: flip the parts that genuinely are true at the tag (e.g. a local trial whose Docker images the tag's own CI publishes) to present tense, and rephrase the remainder in neutral, version-unanchored "in progress" prose — not a "Ships in 0.X" banner, which the gate immediately re-flags. Leave that page's sidebar badge and `documentedFor` in place until the real follow-up (the actual deploy) lands, and name the tracking issue in the page's note. (0.4's exact instance: the one-command local trial vs. the hosted `try.trueppm.com` demo, tracked on #2271 — `getting-started/try-it.md`.)
6. **Verify the removal didn't delete real documentation as a side effect.** A callout's prose sometimes carries the *only* mention of a real API operation on its page — this happened at 0.4: deleting a `:::note[Ships in 0.4]` on `api/reference/sprints.md` also deleted the page's only mention of `POST /api/v1/projects/{id}/sprints/`, because that endpoint was named only inside the callout's "on the current release, sprints are created one at a time via ..." sentence. Run `python3 scripts/check-docs-api-routes.py` after the callout pass. A new violation here means real content was lost — write the missing documentation properly; don't just suppress it with `--update-baseline`. Only re-run `--update-baseline` for ratchet lines your new documentation legitimately resolves (it will tell you which).
7. Run `bash scripts/check-version-status.sh` until it reports zero violations — or exactly the known, tracked exceptions from step 5, never more.
8. `source packages/api/.venv/bin/activate && make pre-push` until fully green, push, and open the MR with `glab mr create` (per the `/mr` skill's format) titled `[HOLD — merge at tag] docs: flip 0.X references to present tense + mark roadmap shipped`. **Stop. Do not merge it yourself** — per the repo's git workflow discipline, hand the MR URL to the user.
9. Only proceed to Step 2 once this MR is merged. Re-pull `main` first.

If `NEW_VERSION` does **not** promote anything — its `### 0.X` section is already under `## Shipped`, true for every `beta.N > 1`, every `rc`, and the eventual stable finalize — skip this entire step. There is nothing to promote and nothing new for `remove-ships-in-callouts.sh` to unlock.

## Step 1b — Documentation audit

For every fragment in `changelog.d/`, verify documentation is in sync:

- **`*.added.md` (new features)** — each must have a corresponding page or section in `packages/website/src/content/docs/features/` (or `packages/website/src/content/docs/getting-started/` / `packages/website/src/content/docs/administration/` where appropriate), with the correct version callout (`> **Added in X.Y**`) and enterprise callout if applicable. Run the `docs-writer` skill if anything is missing.
- **API surface changes** — any new or modified endpoint must be reflected in `docs/api/` and `docs/api/openapi.json`. Regenerate the schema if needed: `git merge origin/main && scripts/export-openapi.sh && git add docs/api/openapi.json`. Run the `api-design` skill (audit mode) if anything is missing.
- **PyPI package surface changes** — any new export, signature change, or behaviour change in `packages/scheduler` must be reflected in the scheduler README and the published docs section; any change to the `packages/mcp` tool list, token scopes, or environment variables must be reflected in `features/mcp-server.md`, `features/mcp-connect.md`, `administration/mcp-server.md`, **and** `packages/mcp/server.json`. Once 1.0 ships, both surfaces are locked for the major line.
- **`*.changed.md` (changed behaviour)** — existing doc pages must reflect the new behaviour; stale screenshots or descriptions must be updated.
- **Helm chart changes** — any new value, env var, or default change must be reflected in `packages/helm/values.yaml` comments and in `packages/website/src/content/docs/administration/`.
- **Breaking changes** — if any exist, ensure a migration or upgrade note is present in `docs/getting-started/` or a dedicated upgrade guide.

Do not proceed to Step 2 until the docs audit is complete. A release with stale documentation is worse than no documentation — users will follow the wrong instructions.

## Step 1c — PyPI README approachability (every release, not gated on a fragment)

Applies to **every package this release publishes to PyPI** — `packages/scheduler/README.md`
and, as of the mcp package's first `mcp-v*` tag (#2809), `packages/mcp/README.md` too. Each is
that package's landing page on PyPI — most people meet the project there before anywhere else —
and Step 1b's "PyPI package surface changes" bullet only fires when a fragment says the surface
changed. Run this check unconditionally, every release, against each PyPI-published package:

- [ ] The Quick start example still runs verbatim against the version being released (paste it into a scratch script and execute it — don't eyeball it). For a server package like mcp, "runs" means the CLI actually starts and the documented env vars/flags match `cli.py`/`config.py` — you may not be able to exercise a real tool call without a live TruePPM instance, but verify every flag, default, and env var name against source, not against the README's own prose.
- [ ] The Features/capability list names everything the package's public surface currently does in human terms — not just what changed this release. For scheduler: every export in `trueppm_scheduler.__all__`. For mcp: every registered tool (count and grouping) in `src/trueppm_mcp/tools.py`. If a prior release added something that never made it into the README's prose, add it now; this gate exists precisely to catch that drift.
- [ ] Any new or changed example block (beyond Quick start) is likewise executed or cross-checked against source, not just read for plausibility.
- [ ] **Does the README state what the package depends on to be useful, not just how to install it?** A README can be technically accurate about installation while never saying what has to already exist for the package to do anything — mcp's README documented tokens and env vars but never stated it requires a *running self-hosted TruePPM instance on a specific minimum version* until this was caught at the 0.4.0-beta.1 cut (the tools call 0.4-only endpoints, so it silently fails against 0.3). Add a Requirements section naming every hard prerequisite explicitly if one doesn't already exist.
- [ ] The README still reads as "what can I do with this and why would I reach for it" for someone who has never seen TruePPM — not as an API changelog. If a feature is easy to describe mechanically but hard to motivate, add the one-line "why" before the code, and consider a short worked example (one concrete question/call and what comes back) if the package's value is otherwise hard to picture from prose alone.

`scripts/release.sh` now bumps the `==X` pins in these READMEs and fails the cut if one is stale, so the pin is no longer this step's job; approachability is. **Do not skip this step because the script covers the pin.** At 0.4.0-beta.4 this pass was skipped and the stale pin was the first thing that surfaced afterward.

This is a review pass, not an agent invocation — do it by hand against the diff since the last release tag for each package (`git log <last-tag>..HEAD -- packages/<pkg>/README.md packages/<pkg>/src`).

## Step 2 — Run the release script

### 2a — The release summary (the one approval you need)

The dated CHANGELOG section opens with a summary, and `release:create` publishes it as the GitLab Release page body. The script ignores the `_Nothing yet._` placeholder and **aborts before bumping anything** when it has no summary (#4041). So:

1. If the user already approved a summary for this version, in this conversation or as a file they point you to, use it verbatim.
2. Otherwise draft one and write it to the scratchpad as `release-summary-<version>.md`. Draw on the target version's roadmap headline, the `changelog.d/` fragments (`added` and `security` first), and anything an upgrader must act on. Shape: an opening line naming the release and the version it **supersedes** (the previous `v*` tag); a paragraph on what's new; a bold **"Upgrading from <previous> or earlier? Read this first."** paragraph when any fragment breaks an upgrade (a chart that now refuses to render, a removed setting, a required migration step); then fixes and security in prose. Keep blank lines between paragraphs, because the Release page keeps them. Show it to the user and **wait for approval**. This is the only pause in a named-version run.

### 2b — Cut

```bash
source packages/api/.venv/bin/activate
RELEASE_ASSUME_YES=1 ./scripts/release.sh <explicit version> --summary "$(cat <summary file>)"
```

Always pass the explicit version from Step 0. `RELEASE_ASSUME_YES=1` is correct here because Step 0 already confirmed it is the next version. Do not set it on a keyword bump you have not checked.

The script, in order:
1. Refuses to run unless the tree is clean, the branch is `main`, and none of the three tags exist
2. Resolves the summary and aborts if there is none, all before touching anything
3. Builds and Trivy-scans the api image (linux/amd64 only; arm64 is first built by the tag pipeline). This takes about 10 minutes on an arm64 Mac.
4. Bumps every manifest to lockstep: `packages/{api,scheduler,mcp}/pyproject.toml`, `packages/mcp/server.json` (both fields), `packages/web/package.json`, `packages/wasm-scheduler/Cargo.{toml,lock}`, `packages/helm/Chart.yaml` (`version` and `appVersion`; the chart's default image tag is `v<appVersion>`). It also restamps `CI_API_TAG` in `.gitlab-ci.yml`, re-locks the three `uv.lock` files, and regenerates `docs/api/openapi.json`. `__version__` literals are **not** bumped; they are read from package metadata (#3878).
   It also rewrites the version pins in `packages/{scheduler,api,mcp}/README.md` (`scripts/bump-readme-pins.sh`; those READMEs are the PyPI long descriptions and were not manifests, so they used to stay one release behind and red `scheduler:test` on `main`), and it refreshes the venv's editable `trueppm-api` install so `make pre-push`'s `schema-check` sees the new version instead of blocking the push.
5. On **every** release, pre-releases included, assembles `changelog.d/` into `[Unreleased]`, rotates it into `## [X.Y.Z] — YYYY-MM-DD` opening with the summary, leaves a fresh `_Nothing yet._` `[Unreleased]`, and deletes the consumed fragments. It rotates `packages/scheduler/CHANGELOG.md` the same way.
6. Runs `remove-ships-in-callouts.sh` for the version's `0.X`. This is a no-op unless the roadmap promoted it (Step 1a).
7. Runs the scheduler's `TestReleaseMetadataConsistency` test against the bumped tree (pyproject version, README pin, top CHANGELOG heading, classifier) and aborts **before committing** if it fails, so a stale pin costs a failed local run instead of a red `main`.
8. Commits `chore(release): bump version to X.Y.Z` and creates three annotated tags: `vX.Y.Z` (images + chart), `scheduler-v<PEP440>` and `mcp-v<PEP440>` (PyPI). The PyPI tags use the PEP 440 form, e.g. `mcp-v0.4.0b4`, not `mcp-v0.4.0-beta.4`.

After it succeeds, sanity-check before pushing: `git status` is clean, `git show --stat HEAD` touches only the files above plus deleted fragments, and the new CHANGELOG section opens with the approved summary.

**Sweep for stale prose the script cannot fix.** The script moves pins; it cannot tell an example version ("for example `0.4.0-beta.3`") from history ("from 0.4.0-beta.3 or earlier"). Grep for the *previous* release and triage each hit:

```bash
grep -rnE '<prev-pep440>|<prev-semver>' -I . \
  | grep -vE '^\./(CHANGELOG\.md|packages/scheduler/CHANGELOG\.md|docs/adr/|scripts/)|node_modules|\.venv|uv\.lock|package-lock|Cargo\.lock|\.astro|/dist/'
```

- **Change** example versions, "latest tagged release" claims (`README.md`, `overview/what-it-does-not-do.md`), and install pins in READMEs, `.env.example`, `docker-compose.prod.yml`, and the Helm README/values.
- **Keep** "from X or earlier" upgrade notes, "added after X", changelogs, ADRs, and test fixtures.
- **Hold** "unproven until the next `v*` tag" and "versions through X predate attestation" until the publish is verified; they flip only after Step 4 confirms it.

Land any fixes as a `docs/` MR **before** the tags are pushed; the tags must point at a commit whose own `main` pipeline is green (Step 3).

**If `git push origin main` is blocked by `schema-check` reporting only a `version` diff**, the venv's installed `trueppm-api` metadata is stale (the script refreshes it, but a different venv than `packages/api/.venv` may be the one pushing). Fix: `uv pip install --python packages/api/.venv/bin/python --no-deps -e packages/api`, then push again. Never `--no-verify`.

If the script fails, read its error before doing anything. It fails closed before step 4 for everything except a failed `uv lock` or openapi export. If it dies after step 4, `git reset --hard origin/main` discards the partial bump; delete any local tags it made first (`git tag -d`).

## Step 3 — Push

**The release commit goes straight to `main`.** This is the one sanctioned direct push to `main` (CLAUDE.md, "Git workflow"); invoking `/release` authorizes it. Push in two steps, so a red `main` can never leave a tag that has been pushed but not published:

```bash
git push origin main                       # pre-push hook runs make pre-push; venv must be active
# wait: the main pipeline at the release commit must reach "success"
git push origin vX.Y.Z scheduler-v<PEP440> mcp-v<PEP440>
```

Poll `glab api "projects/trueppm%2Ftrueppm/pipelines?ref=main&sha=$(git rev-parse HEAD)"` every few minutes. It takes about 12 minutes. Copy the tag names from the script's "Next steps" output rather than reconstructing the PEP 440 suffix.

**Watch it correctly.** Two mistakes from the 0.4.0-beta.4 cut:
- A background watcher written as `until s=$(…); echo …; case $s in …) break;; esac; do sleep 60; done` exits on its first pass, because an `until` condition is the *last* command of its list (`case` returns 0). Its "completed" notification then means nothing. Use `while true; do s=$(…); echo "$(date +%T) $s"; if [ "$s" = success ] || [ "$s" = failed ] || [ "$s" = canceled ]; then break; fi; sleep 90; done`, and when it returns, read the pipeline's real status rather than trusting that it returned.
- Do not wait for a terminal status to find a failure. List `failed` jobs while it runs (`…/pipelines/<id>/jobs?per_page=100&scope[]=failed`): any failed job without `allow_failure` means this pipeline can never go green, so stop and read that job's log immediately. Also check `allow_failure` jobs; `success` can hide one.

**If the release commit's `main` pipeline goes red, stop. The tags are still only local.** Read the failed job's log first; do not retry without a code change unless it is clearly infrastructure (a runner that cannot pull an image). Then:
1. Fix forward on a `docs/` or `fix/` branch and land it by MR. Do not push to `main`; only the release commit itself goes there.
2. When the new `main` HEAD's own pipeline is green, delete the local tags (`git tag -d <three tags>`) and recreate them **on that commit by hand**, with the same messages the script uses (`Release vX.Y.Z`, `Release trueppm-scheduler <pep440>`, `Release trueppm-mcp <pep440>`). Do not re-run `release.sh`: the manifests and changelog are already bumped and rotated, and it would rebuild and rescan the image for nothing.
3. Then push the tags as below.

A `git fetch --tags` that rejects tags with "would clobber existing tag" means a local tag from an earlier re-cut is stale (0.4.0-beta.2 was re-cut). It is not a blocker for this release; verify the version you are cutting exists nowhere (`git tag -l`, `git ls-remote --tags origin`) and leave the stale one alone.

Then watch all three tag pipelines to completion (`glab api "projects/trueppm%2Ftrueppm/pipelines?ref=<tag>"`). Publish jobs sit behind `tag:wait-for-main`. Report every publish job's final status. If a publish job fails, read its log first and never delete a tag whose images have published (Step 5).

Pushing the tag triggers the release pipeline. What happens next depends on the version line:

### Pre-1.0 (`0.x.y` and `0.x.y-<pre>.N`)

- The CI pipeline runs full lint/test/build on the release commit.
- A GitLab Release entry is created automatically by the tag push.
- **GHCR publish is live pre-1.0, as of the 0.4 beta (#939).** `0.3` was the last GitLab-registry-only alpha; every release tag from `0.4.0-beta.1` onward publishes public `api`/`web` images to `ghcr.io/trueppm/{api,web}` (tagged `<version>` and `latest` — see the caution below) and the Helm chart to `oci://ghcr.io/trueppm/charts/trueppm`, alongside the always-on internal GitLab Container Registry mirror. This is **required, not optional**: `GHCR_USER`/`GHCR_TOKEN` (checked in Step 1) must both be set, or `api:publish`/`web:publish`/`helm:publish` fail loudly rather than silently skipping. Every image and the chart are Trivy-scanned, SBOM-attached (Syft, CycloneDX), and Cosign-signed keyless (Sigstore OIDC, no key material). Multi-arch landed **in 0.4**, not 0.5 (#3407): every `api`/`web` image from `v0.4.0-beta.4` on is a manifest list covering `linux/amd64` and `linux/arm64`, and Cosign signs and attests the index itself so `cosign verify` succeeds whichever platform a puller resolves. `v0.4.0-beta.1`–`.3` are `linux/amd64` only. Verify: images and the chart appear at `https://github.com/orgs/trueppm/packages`, and `cosign verify --certificate-identity-regexp '.*gitlab.com.*' --certificate-oidc-issuer https://gitlab.com ghcr.io/trueppm/api:<version>` succeeds.
- **A chart version that outranks its own pre-releases can never be displaced (#3914).** Semver sorts `0.4.0` above every `0.4.0-beta.N`, and Helm skips pre-releases unless asked, so once a plain `0.4.0` sat in `oci://ghcr.io/trueppm/charts/trueppm`, `helm install` with no `--version` — and even with `--devel` — resolved to it forever. Two gates now cover this: `helm:publish` runs `scripts/check-chart-registry.sh --candidate <version>` before `helm push` and refuses a pre-release whose stable base is already published, and the nightly `registry:chart-resolution` job (schedule with `REGISTRY_NIGHTLY=true`) checks that the chart a bare `helm install` resolves to can pull its default images. Neither can *delete* a bad version — that needs a token with `read:packages` + `delete:packages`, and the script's failure message carries the exact `gh api` commands. A red nightly here means a broken chart is live: fix the registry, do not silence the job.
- **`cosign` needs its own login — it does not inherit credentials from `helm registry login`, only from `docker login`.** `api:publish`/`web:publish` run in a `docker:27` image and authenticate GHCR with `docker login`, which `cosign` reads by default, so their `cosign sign`/`cosign attest` calls just work. `helm:publish` runs in a shell-only `alpine/helm` image with no Docker daemon: it only ran `helm registry login` (Helm's own separate credential store), so `cosign sign` 401'd trying to read back the digest it had just pushed — found at the 0.4.0-beta.1 cut, after the chart had already published. Fixed by adding `cosign login ghcr.io -u "$GHCR_USER" -p "$GHCR_TOKEN"` before the sign call. If a future job signs anything without a Docker daemon present, it needs this same explicit login regardless of what else already authenticated.
- **This policy has already drifted once (0.3 → 0.4, #939) without this skill file being updated to match** — that is exactly the failure mode this bullet exists to prevent happening again. Before trusting the paragraph above, re-check `.gitlab-ci.yml`'s publish-stage comments (`grep -n "GHCR is the public release target" .gitlab-ci.yml`) for the *current* policy — a future release could require multi-arch earlier, add arm64, or change which lines publish, without anyone remembering to edit this file.
- **`latest` moves on every tag matching `v[0-9]+\.[0-9]+\.[0-9]+`, pre-releases included** — `api:publish`/`web:publish` retag `:latest` unconditionally, with no stable-only or highest-line gate the way the post-1.0 section below describes. Confirm this is genuinely the intended policy (it may not be) before treating GHCR's `:latest` as "latest stable"; if it isn't intended, that's a `.gitlab-ci.yml` fix to raise with the user, not something this skill can paper over.
- **PyPI publishes are live pre-1.0** and are driven by their own tags, not by `vX.Y.Z`:
  - `scheduler-v<PEP440>` publishes `trueppm-scheduler` (`scheduler:publish`). Verify with `pip index versions trueppm-scheduler`.
  - `mcp-v<PEP440>` publishes `trueppm-mcp` (`mcp:publish`). Verify with `pip index versions trueppm-mcp`, and confirm `uvx trueppm-mcp --help` resolves — three docs pages and the MCP registry manifest tell users to install it that way.
  - Both use PyPI Trusted Publishing (GitLab OIDC), so no token is needed — but the Trusted Publisher must already exist on pypi.org for that project name. `trueppm-mcp`'s is bound to the **`pypi-mcp`** environment; a mismatch fails the job at the mint-token step with PyPI's own 422 explanation, before anything is uploaded.
- Confirm the GitLab Release shows up at `gitlab.com/trueppm/trueppm/-/releases/vX.Y.Z` and the CHANGELOG section is populated.

### At-or-post-1.0 (`>= 1.0.0`)

In addition to the GitLab Release (GHCR publish itself is not the delta here — it's already live pre-1.0 per above; check whether multi-arch has actually landed by the time you're reading this, since it's currently slated for 0.5, i.e. still pre-1.0):

- The CI pipeline builds and pushes multi-arch Docker images (ARM64 + AMD64) to GHCR under `ghcr.io/trueppm/*` — assuming multi-arch has shipped by this point (see above; do not assume the "post-1.0" heading is when it starts). Verify the images appear at `https://github.com/orgs/trueppm/packages` and that both architectures are listed for each tag (`vX.Y.Z`, plus `latest` for stable releases on the highest line).
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
- [ ] 0.4+ pre-1.0: confirm GHCR actually published — `api`/`web` images and the Helm chart at `ghcr.io/trueppm/*`, linux/amd64, Cosign signature + SBOM attestation verifiable. Absence here is now a **failure** to chase, not an expected contract (that contract ended at 0.3, #939).
- [ ] Post-1.0 (or once 0.5 ships, whichever is current — see Step 3): confirm GHCR shows ARM64 + AMD64 manifests for `vX.Y.Z` and (if stable + highest line) `latest`
- [ ] Post-1.0: confirm `docs.trueppm.com` reflects the new version under the correct alias
- [ ] Post-1.0: confirm the enterprise release ran cleanly and pins to `TRUEPPM_OSS_TAG=vX.Y.Z`

## Step 5 — Roll-back guidance

If a release tag was pushed and a critical issue surfaces post-tag:

- **Pre-1.0, 0.3 and earlier** (GitLab-registry only, no public GHCR) — prefer cutting the next patch/pre-release with the fix. Only delete the tag if no consumers have pulled it (typically only true within minutes of push). To delete: `git tag -d vX.Y.Z && git push --delete origin vX.Y.Z`. Confirm with the user before any destructive tag operation.
- **0.4 and later, pre-1.0** — treat like post-1.0 below: GHCR publish (#939) makes the tag's images public and pullable the moment the pipeline finishes, same as after 1.0. Never delete a tag once its GHCR images have published. Cut the next pre-release/patch with the fix instead.
- **At-or-post-1.0** — never delete a tag once GHCR images have published or the enterprise release has pinned to it. Cut a patch release with the fix instead. The previous tag remains visible in history; the patch supersedes it for users.

### Superseding a tag whose PyPI publish already ran

When a `v*` tag is withdrawn or superseded after its publish jobs ran (0.4.0-beta.2 → beta.3), the GitLab Release warning alone is not enough: a `pip` user never sees it (#4060). Do both, in the same sitting:

1. **Yank the PyPI versions the tag produced.** By default that is all three — `trueppm-scheduler`, `trueppm-mcp`, `trueppm-api` at the superseded PEP 440 version — because they share the tag's commit. Narrow it only when the defect is provably confined to one wheel, and say why on the Release page. Yank on pypi.org (project → Manage → the release → Yank) with a reason that names the replacement, e.g. `Superseded by 0.4.0b3: <one-line defect>`. This needs the package owner's account; an agent cannot do it, so hand the user the three project URLs. A yank stays installable for anyone pinning the exact version and is reversible (un-yank); a deletion is neither, so never delete.
2. **Say so on the GitLab Release page** for the superseded tag, naming the replacement and that the PyPI versions are yanked.

Verify with `curl -s https://pypi.org/pypi/<package>/<version>/json` and check `urls[].yanked` is `true`. GHCR images and the Helm chart have no yank concept: judge them separately, and say on the Release page whether they are affected. PyPI versions are immutable and cannot be re-uploaded, so a superseded version number is never reused; the next cut is the next number.
