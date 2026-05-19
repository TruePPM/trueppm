---
title: About TruePPM
description: Who maintains TruePPM and why it exists.
sidebar:
  order: 99
---

## Maintainer

**Kelly Hair** — founder, [MacroDream](https://macrodream.co).

25 years at the intersection of enterprise infrastructure and open-source commercialization. The through-line across that career: being the person in the room who can architect the Kubernetes deployment, build the demo environment, read the room in a CISO review, and restructure a deal that's about to die on the vine — in the same week.

Prior roles include Strategic Alliances Architect at GitLab, Senior Specialist (OpenShift/Kubernetes) at Red Hat, Director of Global Alliances at MayaData (acquired by DataCore), and senior positions across PLUMgrid (acquired by VMware), Chef, Savvis, and HSBC. The pattern across those roles is the same one that drives TruePPM: taking technically strong platforms to market in categories where incumbents have become complacent, and doing it without overstating what the product can actually do.

- GitLab: [gitlab.com/khair1](https://gitlab.com/khair1)
- LinkedIn: [linkedin.com/in/kellyhair](https://www.linkedin.com/in/kellyhair)
- Contact: [kelly@trueppm.com](mailto:kelly@trueppm.com)

## MacroDream

TruePPM is built under [MacroDream](https://macrodream.co), an open-core venture studio. MacroDream's model: identify enterprise software categories where incumbents have captured the market without earning it, build the honest alternative on open foundations, and price it so adoption comes before revenue.

**Products:**

| Product | Status | Description |
|---------|--------|-------------|
| [Visiban](https://visiban.com) | v1.0 live | Kanban platform for customer-facing teams — real-time collaboration, audit trails, dwell-time analytics. Built on Django and React. |
| TruePPM | Community alpha | Open-core P3M platform bridging Agile and Waterfall on a single task model. |
| Blueprint | WIP | Governance template for GitLab + Claude Code teams. |

## Why TruePPM exists

The problem is concrete: every mid-size organisation running software projects has a Project Manager who lives in a Gantt chart and a Scrum Master who lives in a sprint board, and the two views never agree. The reconciliation happens in a spreadsheet, on Monday morning, by hand.

That reconciliation is unnecessary. A single task can carry both a CPM WBS node (with early/late start, float, critical path) and a sprint story (with story points, sprint assignment, burndown) without any translation layer. Build that model and both personas look at the same data, each in the view they prefer.

The community edition is Apache 2.0. The goal is adoption-first — a PM and their team must be fully functional without an Enterprise license. Enterprise adds governance and portfolio coordination for organisations managing multiple programs. It does not gate the core scheduling, collaboration, or hybrid-bridge features.

The scheduling engine (`trueppm-scheduler`) ships separately on [PyPI](https://pypi.org/project/trueppm-scheduler/) under the same Apache 2.0 license — use it without the full application if you just need the CPM and Monte Carlo math.

## License

Apache 2.0 — see [LICENSE](https://gitlab.com/trueppm/trueppm/-/blob/main/LICENSE).

## Support and issues

File bugs and feature requests in the [GitLab issue tracker](https://gitlab.com/trueppm/trueppm/-/issues). Security vulnerabilities should be reported privately — see [SECURITY.md](https://gitlab.com/trueppm/trueppm/-/blob/main/SECURITY.md).
