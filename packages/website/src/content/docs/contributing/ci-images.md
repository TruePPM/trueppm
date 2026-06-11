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
| `registry.gitlab.com/trueppm/trueppm/ci-integration:noble` | `ci:build-integration-image` | `.gitlab/ci-images/integration.Dockerfile` |

All three are rebuilt when their `Dockerfile` or the relevant `pyproject.toml` changes,
plus on the weekly scheduled pipeline so the baked wheels stay current with security
updates. The `ci-integration:noble` image layers Python, `libpq-dev`, `gcc`, and the
scheduler/API dev dependencies on top of the Playwright base image; it is used by the
`web:integration` job.

## Why retention matters

Every rebuild pushes a **new image SHA under the same `:py3.11` tag**, which leaves
the previously-tagged SHA in the registry as an *untagged* layer. Nothing reaps those
untagged layers automatically, so they accumulate indefinitely. At one scheduled
rebuild per week per image — plus `pyproject.toml` churn — the registry is tens of
gigabytes deep within a single release cycle.

It is also a quiet supply-chain risk: a stale untagged SHA that a long-running MR
pipeline still references can pin a vulnerable transitive dependency that the latest
`:py3.11` tag has since dropped.

## The cleanup policy

GitLab's per-project **container registry cleanup policy** solves both problems by
periodically deleting untagged images while keeping the most recent tagged ones. The
policy is currently **disabled** on the project; enable it with these settings:

| Setting | Value | Effect |
|---|---|---|
| `cadence` | `1d` | Run the cleanup daily |
| `enabled` | `true` | Turn the policy on |
| `keep_n` | `10` | Keep the 10 most recent matching images per repository |
| `older_than` | `7d` | Only remove images older than 7 days |
| `name_regex_delete` | `.*` | Consider every tag for deletion… |
| `name_regex_keep` | `(py3\.11|noble)` | …but never delete the live `py3.11` or `noble` tags |

`older_than: 7d` is deliberately generous so an in-flight MR pipeline that pinned a
now-untagged SHA has a week to finish before that layer is reaped.

## Enabling the policy

:::caution[Destructive — run once, as a maintainer]
This permanently deletes untagged registry images. It is an outward-facing,
one-time project-settings change; run it deliberately as a project maintainer or
owner, not from a pipeline.
:::

Set it through the API with `glab`:

```bash
glab api --method PUT projects/trueppm%2Ftrueppm \
  -f 'container_expiration_policy_attributes[cadence]=1d' \
  -f 'container_expiration_policy_attributes[enabled]=true' \
  -f 'container_expiration_policy_attributes[keep_n]=10' \
  -f 'container_expiration_policy_attributes[older_than]=7d' \
  -f 'container_expiration_policy_attributes[name_regex_delete]=.*' \
  -f 'container_expiration_policy_attributes[name_regex_keep]=(py3\.11|noble)'
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
