# Governance

This document describes how TruePPM is run **today**. It does not describe a process
the project has not adopted. When the practice changes, this file changes with it.

## Who runs the project

TruePPM is a product of **MacroDream, LLC**. The community edition is developed in the
open at [gitlab.com/trueppm/trueppm](https://gitlab.com/trueppm/trueppm), the canonical
repository. The GitHub repository is a read-only mirror for discovery; it does not accept
issues or pull requests.

### Maintainer

**Kelly Hair** — project lead, MacroDream, LLC.
[GitLab](https://gitlab.com/kellyhair) · [kelly@trueppm.com](mailto:kelly@trueppm.com)

The project lead is currently the only maintainer: the only person who merges to `main`,
cuts releases, and triages the tracker.

## How decisions are made

- **Work starts as an issue.** Anything beyond a typo or a one-line fix is proposed on the
  [GitLab tracker](https://gitlab.com/trueppm/trueppm/-/issues) before code is written, so
  a change that conflicts with the roadmap or the open-core boundary is caught early.
- **Changes land through merge requests** to `main`. Every merge request needs a green
  pipeline; the pipeline is the enforcement for tests, lint, type checks, migrations, the
  API schema, the open-core import boundary, and the docs accuracy gates.
- **The project lead has final say** on scope, roadmap, and design.
- **Significant design decisions are recorded as Architecture Decision Records** in
  [`docs/adr/`](docs/adr/), which is the source of record, indexed on the docs site under
  [Architecture decisions](https://docs.trueppm.com/architecture/decisions/). A decision
  that is not in an ADR, the roadmap, or this file has not been made.
- **What has shipped and what is planned** is stated in one place: the
  [roadmap](https://docs.trueppm.com/overview/roadmap/). Every other page takes its
  version tense from it.

## Becoming a maintainer

Maintainership is **not currently open** to contributors outside MacroDream, LLC. That will
be revisited as the contributor base grows, and this section will say how when it is.

Contributions are welcome now. [CONTRIBUTING.md](CONTRIBUTING.md) covers the workflow, the
test layers every change needs, and the Developer Certificate of Origin sign-off.

## The open-core boundary

TruePPM has two editions. The **community edition** in this repository is Apache 2.0. The
**enterprise edition** is proprietary and lives in a separate repository.

The line between them is **adoption versus governance**: anything one project manager,
team, or program needs to get its work done belongs in the community edition; cross-program
and portfolio coordination, organization-wide policy, and compliance evidence belong in the
enterprise edition. Three things that could look like governance are deliberately in the
community edition:

- **Basic single sign-on** — logging in through your own OIDC/OAuth identity provider.
- **Single-cluster high availability** — surviving the loss of a pod or node inside one
  cluster.
- **A personal, read-only external task source** — a contributor mirroring their own
  assigned items into My Work, with no writeback.

Two rules keep the boundary honest, and both are enforced in CI rather than by review:

- **The dependency is one-way.** The community edition never imports from the enterprise
  edition (`boundary:imports`, `make enterprise-boundary-check`), so it is fully functional
  without it.
- **Enterprise extends; it does not patch.** Enterprise code registers against published
  extension points. Changing the shape of an extension point is a breaking change and is
  treated as one.

Moving a capability across the line is a project-lead decision, recorded in an ADR — never
done silently by moving code.

## Continuity

- Every release of the community edition is licensed under the
  [Apache License 2.0](LICENSE). That grant is perpetual and irrevocable under the license's
  own terms for the code already released, and anyone may fork it.
- The community edition does not depend on the enterprise edition, so a fork is a complete
  product, not a shell.
- The scheduling engine is also published on its own, under the same license, as
  [`trueppm-scheduler`](https://pypi.org/project/trueppm-scheduler/) on PyPI.

## Conduct and security

- Participation is governed by the [Code of Conduct](CODE_OF_CONDUCT.md).
- Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md) — never in a
  public issue.
