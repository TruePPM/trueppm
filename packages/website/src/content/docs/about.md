---
title: About TruePPM
description: Who maintains TruePPM and why it exists.
sidebar:
  order: 99
---

## Maintainer

**Kelly Hair** — founder, [MacroDream](https://macrodream.co).

25 years at the intersection of enterprise infrastructure and open-source commercialization: shipping products, navigating acquisitions, and watching the cycle of incumbent capture repeat itself. The through-line across that career: being the person in the room who can architect the Kubernetes deployment, build the demo environment, read the room in a CISO review, and restructure a deal that's about to die on the vine — in the same week.

Currently an Account Executive at Portworx (Everpure), a cloud-native storage company. Prior roles include Strategic Alliances Architect at GitLab, cloud-native infrastructure roles at Red Hat and SUSE (OpenShift/Kubernetes), Director of Global Alliances at MayaData (acquired by DataCore), Senior Manager, Program Management at HSBC, and senior positions across PLUMgrid (acquired by VMware), Chef, Savvis, and Verizon Business. The pattern across those roles is the same one that drives TruePPM: taking technically strong platforms to market in categories where incumbents have become complacent, and doing it without overstating what the product can actually do.

- GitLab: [gitlab.com/kellyhair](https://gitlab.com/kellyhair)
- GitHub: [github.com/kellyhair](https://github.com/kellyhair)
- LinkedIn: [linkedin.com/in/kellyhair](https://www.linkedin.com/in/kellyhair)
- Contact: [kelly@trueppm.com](mailto:kelly@trueppm.com)

## MacroDream

TruePPM is built under [MacroDream](https://macrodream.co), an open-core venture studio founded in 2007 and relaunched in 2026. MacroDream's model: identify enterprise software categories where incumbents have grown complacent, extractive, or hostile to the way modern teams actually work, and build the honest alternative — open at the core (Apache 2.0, full feature parity), on-premise as a first-class deployment, transparent pricing with no artificial gatekeeping, and pricing aligned with value delivered.

**Products:**

| Product | Status | Description |
|---------|--------|-------------|
| [Visiban](https://visiban.com) | v1.1 live | Kanban platform for customer-facing teams — real-time collaboration, audit trails, dwell-time analytics. Built on Django and React. |
| TruePPM | Community alpha 3 | Open-core P3M platform bridging Agile and Waterfall on a single task model. |
| [trueppm-scheduler](https://pypi.org/project/trueppm-scheduler/) | Apache 2.0 on PyPI | Standalone CPM/Monte Carlo scheduling library — usable without the full application. |
| Blueprint | WIP | Governance template for GitLab + Claude Code teams. |

## Why TruePPM exists

The problem is concrete: every mid-size organization running software projects has a Project Manager who lives in a Gantt chart and a Scrum Master who lives in a sprint board, and the two views never agree. The reconciliation happens in a spreadsheet, on Monday morning, by hand.

That reconciliation is unnecessary. A single task can carry both a CPM WBS node (with early/late start, float, critical path) and a sprint story (with story points, sprint assignment, burndown) without any translation layer. Build that model and both personas look at the same data, each in the view they prefer.

The community edition is Apache 2.0. The goal is adoption-first — a PM and their team must be fully functional without an Enterprise license. Enterprise adds governance and portfolio coordination for organizations managing multiple programs. It does not gate the core scheduling, collaboration, or hybrid-bridge features.

## License

The Community Edition is Apache 2.0 — see [LICENSE](https://gitlab.com/trueppm/trueppm/-/blob/main/LICENSE). For the full picture — the enterprise boundary, the CI-enforced dependency-license policy, and third-party attribution — see [License & Third-Party Attribution](/license/).

## Support and issues

File bugs and feature requests in the [GitLab issue tracker](https://gitlab.com/trueppm/trueppm/-/issues). Security vulnerabilities should be reported privately — see [SECURITY.md](https://gitlab.com/trueppm/trueppm/-/blob/main/SECURITY.md).
