---
title: CI base images
description: The baked ci-api, ci-scheduler, and ci-integration images used by CI, and the container-registry cleanup policy that keeps the registry from growing without bound.
---

TruePPM's CI runs its Python-dependent jobs against three **baked base images** rather
than installing system packages and dependency wheels on every pipeline. The images
pre-bake `libpq-dev`, `gcc`, and all dev-dependency wheels, so the per-job
`pip install -e` is a fast editable re-link with no apt-get and no wheel downloads —
this shaves roughly three minutes off each of the API jobs (and the same cold-install
cost off `web:integration`).

This page is for **maintainers of the TruePPM GitLab project** — it concerns the
project's own container registry, not a self-hosted TruePPM deployment.

## The baked images

| Image | Built by | Dockerfile |
|---|---|---|
| `registry.gitlab.com/trueppm/trueppm/ci-api:py3.11` | `ci:build-api-image` | `.gitlab/ci-images/api.Dockerfile` |
| `registry.gitlab.com/trueppm/trueppm/ci-scheduler:py3.11` | `ci:build-scheduler-image` | `.gitlab/ci-images/scheduler.Dockerfile` |
| `registry.gitlab.com/trueppm/trueppm/ci-integration:$PLAYWRIGHT_BASE_TAG` | `ci:build-integration-image` | `.gitlab/ci-images/integration.Dockerfile` |

All three are rebuilt when their `Dockerfile` or the relevant `pyproject.toml` changes,
plus on the weekly scheduled pipeline so the baked wheels stay current with security
updates. The `ci-integration` image layers Python, `libpq-dev`, `gcc`, and the
scheduler/API dev dependencies on top of the Playwright base image; it is used by the
`web:integration`, `api:fuzz`, `perf:load`, and `sso:integration` jobs.

### Why `ci-integration` is version-stamped

`ci-integration` is tagged with `$PLAYWRIGHT_BASE_TAG` (currently `v1.62.1-noble`),
not with a fixed name, because it **carries browsers**. Our runners pull
`if-not-present`, so a tag whose name never changes is served from whatever copy the
runner already has — even minutes after a rebuild pushed a new digest to the same
name. When the image was tagged `:noble`, the Playwright 1.62.1 bump broke `main` for
two pipelines exactly this way: `web:integration` ran a stale cached image and every
spec died at `browserType.launch: Executable doesn't exist`, because
`@playwright/test` resolves the browser through a version-stamped path on disk and
never re-downloads it (#2825). Stamping the version into the tag mints a name no
runner can already hold, which forces a real pull.

`ci-api` and `ci-scheduler` keep fixed tags: they carry only Python wheels, and a
stale one costs a slower `pip install -e` rather than a hard failure.

## Why retention matters

Every rebuild pushes a **new image SHA under the same `:py3.11` tag**, which leaves
the previously-tagged SHA in the registry as an *untagged* layer. Nothing reaps those
untagged layers automatically, so they accumulate indefinitely. At one scheduled
rebuild per week per image — plus `pyproject.toml` churn — the registry is tens of
gigabytes deep within a single release cycle.

A Playwright bump is the one case that behaves differently: it retires the whole
`ci-integration` / `playwright-base` tag rather than orphaning a SHA under a reused
one, so the superseded tag stays tagged and the `^v.*$` keep pattern below preserves
it. Those are worth deleting by hand a release or two after a bump — they are large,
and nothing reaps them.

It is also a quiet supply-chain risk: a stale untagged SHA that a long-running MR
pipeline still references can pin a vulnerable transitive dependency that the latest
`:py3.11` tag has since dropped.

## The cleanup policy

GitLab's per-project **container registry cleanup policy** solves both problems by
periodically deleting old tags while keeping the most recent ones. It is **enabled**
on the project and currently set to:

| Setting | Value | Effect |
|---|---|---|
| `cadence` | `1d` | Run the cleanup daily |
| `enabled` | `true` | Policy is on |
| `keep_n` | `10` | Keep the 10 most recent matching tags per repository |
| `older_than` | `7d` | Only consider tags older than 7 days |
| `name_regex` | `.*` | Consider every tag for deletion… |
| `name_regex_keep` | `^v.*$\|^latest$` | …except release tags and `latest` |

`older_than: 7d` is deliberately generous so an in-flight MR pipeline that pinned a
now-untagged SHA has a week to finish before that layer is reaped.

:::danger[Do not narrow `name_regex_keep` without reading #2803]
An earlier configuration used `keep_n: 1` with `name_regex_keep: null`, and the
first daily sweep deleted the published `api:v0.3.0-alpha.3` and
`web:v0.3.0-alpha.3` release images. `^v.*$` is what protects every `v*` release
tag, and it is the reason this policy is worth being careful with: it lives in
project settings, outside the repo, so nothing in a code review will catch a
regression. #2803 tracks the nightly probe that fails red when a release image goes
missing.
:::

This pattern is also what protects the version-stamped CI images: `ci-integration`
and `playwright-base` are tagged `v1.62.1-noble`, which matches `^v.*$`. Keep the
leading `v` if the tag scheme ever changes.

The fixed-name tags — `ci-api:py3.11`, `ci-scheduler:py3.11`, `ci-wasm:1.85`,
`ci-keycloak:26` — match no keep pattern and survive on `keep_n` alone, because each
of those repositories holds only the one tag. That is thin protection: if one of
them ever accumulates more than ten tags, the live tag becomes eligible for
deletion, and the symptom is CI failing to pull an image with no code change to
blame. Widening the keep pattern to cover them is worthwhile — just never at the
cost of `^v.*$`.

## Changing the policy

:::caution[Destructive — run deliberately, as a maintainer]
This permanently deletes registry images. It is an outward-facing project-settings
change; run it as a project maintainer or owner, not from a pipeline, and re-read
the warning above first.
:::

Read the current policy before changing it:

```bash
glab api projects/trueppm%2Ftrueppm | jq .container_expiration_policy
```

Set it through the API with `glab` — this writes the values in the table above:

```bash
glab api --method PUT projects/trueppm%2Ftrueppm \
  -f 'container_expiration_policy_attributes[cadence]=1d' \
  -f 'container_expiration_policy_attributes[enabled]=true' \
  -f 'container_expiration_policy_attributes[keep_n]=10' \
  -f 'container_expiration_policy_attributes[older_than]=7d' \
  -f 'container_expiration_policy_attributes[name_regex_delete]=.*' \
  -f 'container_expiration_policy_attributes[name_regex_keep]=^v.*$|^latest$'
```

The same settings are available in the GitLab UI under
**Settings → Packages and registries → Clean up image tags**.

## Verifying it took effect

```bash
# 1. Confirm the policy is enabled with the expected settings.
glab api projects/trueppm%2Ftrueppm | jq .container_expiration_policy

# 2. Confirm a run is scheduled — next_run_at should be in the future.
glab api projects/trueppm%2Ftrueppm \
  | jq '.container_expiration_policy.next_run_at'
```

After the next scheduled run (or after manually re-running `ci:build-api-image`),
the prior image SHA should show as **untagged** in the registry UI, and untagged
layers older than the `older_than` window should be gone.

## Related

- [Contributing guide](/contributing/guide/) — branching, commits, testing.
- [Release process](/contributing/release/) — version bump, changelog, tag, publish.
- The image build jobs live in `.gitlab-ci.yml` (`ci:build-api-image`,
  `ci:build-scheduler-image`, `ci:build-integration-image`) with their Dockerfiles
  under `.gitlab/ci-images/`.
