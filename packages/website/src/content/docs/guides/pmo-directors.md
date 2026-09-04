---
title: For PMO Directors
description: What the community edition gives a PMO at the program level today — rollup, roles, and an operational audit log — and where the line to enterprise portfolio governance sits.
---

You run a program office. You need visibility across the work, capacity you can plan against, and a compliance story you can defend — and you evaluate tools professionally, so you want the line drawn honestly. Here it is up front: **the community edition is built for the program level — one or more related projects run by a team. Portfolio governance across many programs is the enterprise edition, by design.**

That split is deliberate, not a gap. TruePPM's whole model is adoption-first: a program gets fully productive on the open-source core, and the organization adds the enterprise layer for portfolio coordination, org-wide identity governance, and compliance evidence when it needs to govern across programs. This guide covers what the core gives you today, and exactly where enterprise begins.

## What you get today (community edition)

### Program-level rollup

A **program** groups related projects under one team. The program view rolls up KPIs, cadence, and a shared risk policy across its projects, so a program manager sees the whole effort in one place — not one project at a time. This is the staging ground beneath a portfolio: real cross-*project* coordination, within a single program.

→ See [Programs](/features/programs/) and [Program rollup settings](/features/settings/program-rollup/)

### An operational audit log

Every consequential change — membership edits, role changes, settings updates, lifecycle actions — is recorded in a workspace **audit log** that Owners and Admins can read. It answers "who changed what, and when" for day-to-day operations.

Be precise about what this is and isn't: it is an *operational* log for running the workspace. The **immutable, compliance-grade audit trail** with retention guarantees and SOC 2 evidence export is an enterprise capability. If your hard requirement is tamper-evident audit for an auditor, that's the enterprise line.

→ See [Audit log](/administration/audit-log/)

### Role-based access control

TruePPM enforces a **five-role model** (Owner / Admin / Scheduler / Member / Viewer) on every project, at the engine level — not just hidden in the UI. People see and change only what their role allows. This is the access-control foundation. Basic OIDC/OAuth single sign-on against your own identity provider lands in the community core in 0.4; the org identity-*governance* layer — **SAML 2.0 federation, SCIM provisioning, LDAP/AD directory sync, and enforced org-wide SSO** — sits on top of it in the enterprise edition.

→ See [RBAC](/administration/rbac/) and [Sharing & access](/administration/sharing-and-access/)

### Self-hosted, so data residency is yours

The core runs entirely on your infrastructure — PostgreSQL, Valkey, and a Helm chart for Kubernetes. No data leaves your network, which is the foundation of any residency or regulatory story. (The compliance *evidence* layer on top — immutable audit, approval workflows — is enterprise.)

→ See [Deployment](/administration/deployment/) and [Security](/administration/security/)

### Confidence-weighted forecasts you can repeat upward

Each project carries a Monte Carlo forecast — P50 / P80 / P95 — instead of a single optimistic date. When the CEO asks "will this deliver by Q4?", the answer is a probability, not a guess. That's the same number your PMs commit on, so the story is consistent from team to board.

→ See [Scheduler engine — Monte Carlo](/features/scheduler/)

## Evaluate it yourself (~10 minutes)

Run these steps in order — they start from a machine with nothing running.

1. **Start the stack and load the program data set.** From your TruePPM checkout (if you have not installed yet, start with [Installation](/getting-started/installation/)):

   ```bash
   make up
   docker compose exec api python manage.py load_sample_project --with-personas   # Atlas (default)
   ```

   **Atlas is the bundled data set that contains an actual program** — three related projects under one lead, which is what steps 4 and 5 are about. The command prints the sample's persona logins (`atlas-alex`, `atlas-priya`, …) and their shared password when it finishes. On a local Docker stack (`DEBUG=True`) that password is `demo`; anywhere else it is `$TRUEPPM_DEMO_PASSWORD` if you set it, otherwise a random token printed once — copy it before you clear the terminal.

2. **Sign in as the PMO director.** Open `http://localhost:5173` and sign in as **`atlas-priya`** — Priya Nair, Engineering Lead, seeded with the **Admin** role, which is what makes step 6 reachable.

3. **Open the multi-team sprints lens.** In the left navigation rail, under **Deliver**, click **Sprints** (`/projects/:id/sprints`), then flip the **`[ This project | My Teams ]`** toggle in the breadcrumb row to **My Teams**. It aggregates the active sprints across projects into one view — day-of-sprint, remaining points, capacity, trend, and forecast, sorted most-behind first. This is program-level visibility without opening each project.

   :::caution[No bundled sample can show this toggle yet]
   It only appears for someone holding unfinished work in two or more *simultaneously active* sprints — otherwise there is nothing to aggregate and the control stays hidden. No persona in any bundled sample currently meets that bar: Atlas has two active sprints (Platform Core and GTM Readiness) but their assignees do not overlap, and persona accounts are namespaced per sample (`atlas-…`, `aurora-…`), so loading a second sample cannot give one account work in both. Tracked in [#3393](https://gitlab.com/trueppm/trueppm/-/issues/3393). To see the lens today, assign yourself a task in each project's active sprint first.
   :::

4. **Open the program view.** Sign in as **`atlas-alex`** (the Atlas program lead) and use the top-bar location switcher to select the **Atlas Platform Launch** *program* rather than a project inside it. Open its **Overview** (`/programs/:id/overview`) — the rollup across its three projects, the cross-project picture a program manager works from.

5. **Follow the cross-project critical path.** Click **Schedule** in the same rail (`/programs/:id/schedule`). Platform Core gates Migration, which gates the public-launch milestone — one critical path running straight through three project boundaries.

6. **Open the audit log** at **Settings → Audit log**, back on the `atlas-priya` account. Confirm that operational changes are recorded with who and when. This step needs Admin or Owner — it is why the walkthrough uses `atlas-priya` rather than `atlas-sam`.

Then judge it against your real bar. Your top criteria — a one-glance portfolio dashboard across 40 projects, enforced org-wide SSO with directory sync, and a tamper-evident audit trail — are **enterprise**, and intentionally not in this repo. The honest question for the community edition is narrower: *does a single program run cleanly on the open core, so adoption can start before the portfolio layer is bought?*

## Where the line is: community vs. enterprise

| Capability | Edition | Why |
|---|---|---|
| Program-level rollup (related projects, one team) | Community | Cross-*project* coordination within one program |
| Operational audit log (who changed what) | Community | Day-to-day workspace operations |
| Five-role RBAC, self-hosted | Community | Access-control and residency foundation |
| Per-project confidence forecasts (P50/P80/P95) | Community | The number you repeat to the board |
| Basic single sign-on (OIDC/OAuth via your own IdP) | Community | Login federation a self-hoster expects (lands 0.4) |
| Portfolio dashboard & health scores | Enterprise | Visibility *across many programs* |
| Org identity governance (SAML 2.0, SCIM, LDAP/AD sync, enforced SSO) | Enterprise | Directory-driven provisioning and enforced org-wide SSO |
| Immutable audit trail, SOC 2 evidence export | Enterprise | Tamper-evident compliance, not operations |
| Cross-program resource leveling & heat map | Enterprise | Capacity *across* programs |
| Demand intake & prioritization workspace | Enterprise | Portfolio investment governance |

:::note[The test]
"Would a program manager need this to run their program?" → community. "Is this coordination *across* programs, org-level policy, or compliance evidence?" → enterprise. The community edition has to be fully functional for one program on its own — that's the adoption flywheel the whole model depends on.
:::

## Where to go next

- [Installation](/getting-started/installation/) — stand up an instance, or send this to whoever will
- [Evaluation guide](/getting-started/evaluation-guide/) — the Atlas sample, a three-project program at scale
- [Programs](/features/programs/) — the program entity and its rollup
- [RBAC](/administration/rbac/) and the [Audit log](/administration/audit-log/) — the governance surface available today
- [Roadmap](/overview/roadmap/) — the enterprise portfolio layer and when it lands
