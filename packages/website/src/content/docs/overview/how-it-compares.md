---
title: How TruePPM Compares
description: Named, dated comparison against the open-source PPM field and the commercial scheduling tools — including the head-to-heads TruePPM loses.
documentedFor: "0.4"
---

This page names competitors and cites sources. It also names the comparisons TruePPM
**loses**, because a comparison page that only lists wins is an advertisement, and you
should not make a tooling decision on an advertisement.

:::caution[Read the version status first]
TruePPM is pre-GA. The current shipped release is the first beta, 0.4. Every claim
below about TruePPM's own capabilities describes what is in `main` today, unless
marked otherwise. The [roadmap](/overview/roadmap/) is the authoritative
Shipped / Underway / Planned record.
:::

:::note[How to read the claims here]
The SSO/auth comparisons and the LibrePlan rows below carry dated, linked
footnotes, because vendor packaging changes and a stale citation is worse than
none — re-verify against the linked source before quoting one. The LibrePlan
Monte Carlo footnote cites LibrePlan's own source files, not its feature list,
because the distinction it draws is a methodological one that a feature list
cannot settle. The rest of the claims in both tables reflect our
own reading of each vendor's public documentation and product pages; they are not
individually dated and footnoted, so treat them as directionally correct rather than
independently audited. Claims about TruePPM's own capabilities are checkable against
the [engine package](https://pypi.org/project/trueppm-scheduler/) and the
[tested scale envelope](/administration/sizing/#tested-envelope). If a row here is
wrong, [open an issue](https://gitlab.com/trueppm/trueppm/-/issues) and we will
correct it.
:::

## The one-sentence version

TruePPM ships **Monte Carlo schedule risk analysis that resamples the whole dependency
network**, in an API-first, real-time, self-hostable platform whose **scheduling engine
you can install and audit by itself** — and that last part is the one we are aware of no
other PPM tool, open or commercial, matching. It is *not* a Primavera P6 or MS Project
replacement, because it has no resource leveling and one constraint type.

It is also **not** the only open-source tool with a Monte Carlo screen. LibrePlan has had
one for well over a decade, and it is narrower rather than absent — see
[Where LibrePlan beats TruePPM](#where-libreplan-beats-trueppm) and the methodological
difference spelled out under the table below.

## Against the open-source field

| | CPM with float | Monte Carlo | Agile board coupled to the schedule | Engine installable standalone | OIDC/OAuth login in the free core | MCP server in the free core |
|---|---|---|---|---|---|---|
| **TruePPM** | Yes | **Yes** | **Yes — same object** | **Yes** (`pip install trueppm-scheduler`) | **Yes** (shipped in 0.4) [^sso] | **Yes** (shipped in 0.4, read-only) |
| OpenProject | Gantt with dependencies; **no critical path** [^opcp] | No | Board and Gantt as adjacent views | No | Enterprise add-on [^op] | Enterprise add-on [^opmcp] |
| **LibrePlan** | Yes | **Yes** — but only along an already-critical path [^lpmc] | No | No | No — LDAP only [^libreplan] | No [^libreplan] |
| Redmine | Via third-party plugins | No | No | No | Third-party plugin [^redmine] | No |
| Plane | No | No | Agile-only | No | Paid / Commercial editions [^plane] | No |
| Taiga | No | No | Agile-only | No | Third-party plugin [^taiga] | No |
| Leantime | No | No | No | No | Yes — free in the core [^lean] | No |
| ProjectLibre / GanttProject | Yes (desktop) | No in the open-source desktop — but **yes in ProjectLibre Cloud**, a separate proprietary SaaS [^plcloud] | No | No | n/a — desktop, no server auth | No |

Four things this table is really saying:

**Monte Carlo is *almost* the empty column — and where it exists, it is narrower than
ours.** LibrePlan is the exception, and it is a real one: an AGPL-3.0 project, actively
released, with a dedicated Monte Carlo simulation screen. [^libreplan] The difference is
methodological, and we checked it against LibrePlan's source rather than against its
feature list. LibrePlan simulates **one critical path at a time**: it starts from the
tasks the deterministic pass already marked critical, enumerates the paths through the
network, discards every path containing a non-critical task, and then per run **sums**
one sampled duration per task along the single path you selected. [^lpmc] A near-critical
path therefore cannot become critical under uncertainty — it was filtered out before the
first run, and the simulation has no merge point at which to take a maximum, so merge
bias is structurally invisible to it. Sampling is discrete three-point as well: each task
draws exactly its optimistic, normal, or pessimistic duration, never a value between
them. TruePPM instead re-runs the **full CPM forward pass over the entire network** on
every run, across all four dependency types, so paths trade places between runs and merge
bias lands in the percentiles.

That is a real, checkable difference, and it is the claim we will defend — not "LibrePlan
does not have Monte Carlo," which is false. Nor is ours settled: a TruePPM percentile can
still land before the CPM finish on a network carrying a Finish-to-Finish or
Start-to-Finish edge, and the risk register does not yet feed the forecast. Both are open
and written up under [Known issues](/overview/known-issues/).

**The agile/waterfall split is a real fork, and most tools pick a side.** Plane and
Taiga are agile-only; LibrePlan, ProjectLibre and GanttProject are schedule-only. OpenProject
carries both, but as adjacent views over related records rather than one coupled
model. In TruePPM the board card and the Gantt bar are the *same row* — close a
sprint and measured velocity reforecasts the CPM finish.

**Leantime deserves credit on SSO.** It is the one open-core tool in this field that
does not charge for OIDC login. Only SAML is a paid add-on. [^lean] The
[SSO tax](/overview/sso-is-not-enterprise/) page covers the full picture.

**The MCP column is the SSO column repeating itself.** OpenProject shipped an MCP
server in 17.2 (March 2026) — also read-only, also well built, and gated behind the
Professional plan and above. [^opmcp] TruePPM's is in the free core. We think agent
access to your own project data belongs on the same side of the line as logging in:
it is a way of *reaching* your data, not a way of governing an organization. The
enterprise counterpart is the governance overlay — approval workflows, org-wide model
and data-egress policy, cross-team audit — not the endpoint itself.

## Where OpenProject beats TruePPM

The table above lists six columns TruePPM wins and none it loses, which would make it
exactly the advertisement this page opens by warning about. OpenProject is also the
tool most people reading this are actually choosing between, so its wins matter more
than P6's.

Everything in this table is in OpenProject's **free Community edition**. None of it
exists in TruePPM at all.

| Capability | OpenProject Community | TruePPM |
|---|---|---|
| Custom work-item types and statuses | Unlimited, per project | **No** — six fixed statuses; board columns can be renamed, reordered, hidden and WIP-capped, but not added. Per-project statuses over a fixed canonical set are proposed in [ADR-1049](/architecture/decisions/)'s sibling [ADR-1050](/architecture/decisions/), sequenced for 0.6 |
| Workflow transition rules | Per type, per role | **No** |
| Custom roles and granular permissions | Yes | **No** — five fixed roles |
| Wiki | Yes | **No** |
| Documents and file space | Yes | **No** — attachments hang off tasks only |
| Meetings with agendas and minutes | Yes | **No** |
| Forums and news | Yes | **No** |
| Budgets and cost reporting | Yes | **No** — no cost model at all (EV-lite planned 0.8) |
| Project hierarchy | Arbitrary trees with inheritance | Two levels — program → project |
| Languages | 30+ | **English only** — no i18n framework wired in |
| Time in market | Shipping since 2012 | First commit March 2026 |

**The two that end evaluations fastest are the first three rows and the wiki.** A team
whose process is `Triage → Spec → Build → QA → UAT → Done` cannot express it in
TruePPM today, and there is no partial version of that — it is a hard stop rather
than a compromise. And with no wiki or documents surface, adopting TruePPM means
keeping another tool for everything that is not a task.

We are not going to pretend these are minor. They are the reason a team that needs a
general-purpose project workspace should pick OpenProject, and the honest framing is
narrower than "TruePPM is better":

> **Choose TruePPM if the schedule is the hard part.** If what you need is a critical
> path, float, and a defensible forecast date, TruePPM computes them and OpenProject
> does not. [^opcp] **Choose OpenProject if breadth is the hard part** — if you need
> a configurable workflow, a wiki, meetings, and budgets more than you need a
> forecast.

TruePPM is also five months old and pre-1.0 against a project shipping since 2012.
Expect rough edges, read [Known issues](/overview/known-issues/) before you pilot,
and see the [tested scale envelope](/administration/sizing/#tested-envelope) for the
measured limits — a project stays comfortable in the Schedule view to roughly 2,000
tasks (about 1,000 on 0.4.0-beta.1), and slows steeply past 8,000.

## Where LibrePlan beats TruePPM

LibrePlan is the closest thing TruePPM has to a direct open-source peer — the only other
tool in the table above that treats the schedule, rather than the issue list, as the
primary artifact. It is AGPL-3.0, it is not a zombie (1.6.0 in May 2026, 1.6.1 in June
2026, commits on `main` through August 2026), and **two of its capabilities sit on
TruePPM's own [What TruePPM doesn't do yet](/overview/what-it-does-not-do/) list**.
[^libreplan]

| Capability | LibrePlan | TruePPM |
|---|---|---|
| Automatic resource reallocation to reduce overload | Yes, in the core [^libreplan] | **No** — a single-program leveling engine is sequenced for 0.6 |
| Earned value management | Yes, in the core [^libreplan] | **No** — no cost model at all (EV-lite planned 0.8) |
| Time in market | Scheduling sources carry 2009–2010 copyright headers [^libreplan] | First commit March 2026 |

Those are not small. Resource leveling and earned value are the two items most often
cited as the reason TruePPM is not yet a P6 or MS Project replacement, and an AGPL tool
has shipped both for over a decade.

Where TruePPM is ahead is the platform around the schedule rather than the scheduling
mathematics: LibrePlan has no agile board coupled to the schedule, no MCP server, no
OIDC/OAuth login (its authentication story is LDAP), and its scheduling code ships as
part of one Java/ZK web application rather than as a package you can install and audit by
itself. [^libreplan]

> **Choose LibrePlan if** resource reallocation or earned value decides it, and a
> Java/ZK deployment suits you. **Choose TruePPM if** you want the schedule reachable
> over a real API, a board on the same objects, and a risk model that resamples the whole
> network rather than one path.

## A note on Taiga's maintenance status

Taiga appears in the table above as a feature comparison, which implies a live
alternative. Its activity is worth stating separately, because it is more
decision-relevant than any capability cell: the current release is **6.9.0 (October
2025)**, and the ground-up rewrite at `kaleidos-ventures/taiga` has had **no commit
since December 2023**. [^taigaact] The classic `taiga-front` / `taiga-back`
repositories still take occasional maintenance commits.

We mention it because we are building a Taiga importer and it would be dishonest to
do that while presenting Taiga as a peer still in active development. Verify it
yourself before drawing a conclusion — the repositories are public and the commit
dates are the whole argument.

## Against the commercial scheduling tools

This is where the honest losses are.

| | TruePPM | Primavera P6 | MS Project |
|---|---|---|---|
| CPM, 4 dependency types, lead/lag on every link | Yes | Yes | Yes |
| Monte Carlo risk | **In the core** | Separate product (Primavera Risk Analysis) | Separate product (third-party) |
| **Resource leveling** | **No** (a single-program engine is sequenced for 0.6) | Yes | Yes |
| **Constraint types** | **1** (start-no-earlier-than; a deadline with negative float is planned for 0.5) | Full set | 8 + deadlines |
| **Cost / earned value** | **No** (EV-lite planned 0.8) | Yes | Yes |
| **Tested task ceiling** | **~2,000 in the Schedule view** (~1,000 on 0.4.0-beta.1; 16,000 takes ~40 s to open, and 100,000 is out of reach — see [where each part runs out](/administration/sizing/#toward-100000-tasks)) | Very large (100k+ activities in practice) | Large |
| Sub-day scheduling | No (planned 0.6) | Yes | Yes |
| Agile board / sprints | Yes, on the same objects | No | No |
| Real-time multi-user web | Yes | Limited | Limited |
| REST API + WebSocket, API-first | Yes | Partial | Limited |
| Self-hosted / on-premises deployment | Yes | Yes (P6 EPPM has a traditional on-prem deployment option) | Yes (Project Server, on-prem option) |
| Per-seat / named-user licensing | **No** — Apache 2.0, no license cost | Yes | Yes |
| Engine auditable standalone | **Yes** | No | No |

**Do not choose TruePPM over P6 or MS Project if** you need resource leveling,
must-finish-on constraints, earned value, sub-day durations, or schedules beyond a
few thousand tasks. Those are real capabilities that real schedulers depend on, and
TruePPM does not have them. See
[What TruePPM doesn't do yet](/overview/what-it-does-not-do/).

**Do choose TruePPM over them if** you want a schedule that lives on your own
infrastructure with a real API, a team that works in sprints without the PM
maintaining a parallel plan, probabilistic forecasts without buying a second product,
and an engine you can verify rather than trust.

## On Monte Carlo pricing

Across the commercial field, probabilistic schedule risk is a **separately licensed
product** that operates on a schedule exported from your scheduling tool: Deltek
Acumen Risk, Barbecana Full Monte, Safran Risk, and Oracle Primavera Risk Analysis
are the common ones. We do not publish price comparisons because these vendors mostly
do not publish list prices — but "separately licensed product" is the structural
point, and it is checkable from each vendor's own product pages. The exception we are
aware of is ProjectLibre Cloud, which bundles Monte Carlo into the SaaS subscription
rather than selling it as a second product. [^plcloud]

TruePPM computes P50/P80/P95 and per-task sensitivity in the **same engine** that
computes the deterministic dates, in the free core, with no export step. You can
confirm that in sixty seconds:

```bash
pip install trueppm-scheduler
```

## Against Jira

Jira is not a scheduling tool and does not claim to be, so the comparison is narrow
but it is the one most teams actually face.

Jira + Advanced Roadmaps does capacity-based planning across teams. It does not
compute a critical path, float, or a probabilistic finish date. TruePPM does all
three, on the same task objects your team moves across a board.

TruePPM's answer to Jira is deliberately **not** "switch." A personal, read-only,
one-way Jira sync into My Work shipped in 0.4 so contributors never double-enter, and a
one-time migration import follows in 0.6 for teams that decide to move. Run both and
get the CPM forecast without asking anyone to change tools first.

Where Jira wins and will keep winning: ecosystem, marketplace, integration breadth,
and developer familiarity. TruePPM's plugin architecture is planned for 0.7 and a
public Extension SDK for 0.9.

## Related

- [What TruePPM doesn't do yet](/overview/what-it-does-not-do/) — the maintained gap list
- [SSO is not an enterprise feature](/overview/sso-is-not-enterprise/) — the full SSO-tax comparison, cited
- [Computed, not guessed](/overview/computed-not-guessed/) — why the engine, not a model, answers
- [Roadmap](/overview/roadmap/) — the authoritative Shipped / Underway / Planned record

[^sso]: Basic OIDC / OAuth2 login federation shipped in the OSS core in 0.4. See
    [SSO is not an enterprise feature](/overview/sso-is-not-enterprise/) for the full
    OSS-versus-enterprise carve-out.

[^opcp]: OpenProject does not implement critical-path analysis; it is an open feature
    request on their community tracker, and the documented workaround is to create
    predecessor/successor relations only for the work packages you believe are
    critical. See <https://community.openproject.org/topics/13906> and the Gantt chart
    FAQ: <https://www.openproject.org/docs/user-guide/gantt-chart/gantt-chart-faq/>.
    Verified 2026-08-29.

[^opmcp]: OpenProject 17.2 release notes — the MCP Server is an Enterprise add-on,
    available from the Professional plan upward, and is read-only:
    <https://www.openproject.org/docs/release-notes/17-2-0/>,
    <https://www.openproject.org/docs/system-admin-guide/integrations/mcp-server/>.
    Verified 2026-08-29.

[^libreplan]: LibrePlan repository metadata, README feature list, and source tree, all
    read 2026-09-20 at <https://github.com/LibrePlan/libreplan>: AGPL-3.0, 353 stars, 183
    forks, not archived; releases 1.6.0 (2026-05-12) and 1.6.1 (2026-06-11); most recent
    commit on the `main` branch 2026-08-25. The
    [README feature list](https://github.com/LibrePlan/libreplan/blob/main/README.rst) is
    the source for automatic resource reallocation ("Automatic resource reallocation in
    order to minimize overload (overtime)"), earned value ("Earned Value Management"),
    the Monte Carlo screen ("Monte Carlo method. Statistical simulation to calculate the
    possibility to complete a project in a range of dates"), and authentication
    ("Complete users system with permissions, LDAP authentication, etc."). The 5,059-path
    source tree contains no OIDC, OAuth, OpenID, SAML, MCP, Kanban, sprint, or Scrum
    path; the scheduling and Monte Carlo sources carry 2009–2010 and 2010–2011 copyright
    headers.

[^lpmc]: LibrePlan's Monte Carlo method, read from its source on 2026-09-20 rather than
    from vendor description.
    [`MonteCarloModel.java`](https://github.com/LibrePlan/libreplan/blob/main/libreplan-webapp/src/main/java/org/libreplan/web/montecarlo/MonteCarloModel.java):
    the entry point is `setCriticalPath(List<TaskElement> tasksInCriticalPath)`, and each
    run's finish comes from `calculateEndDateFor`, which sums one sampled duration per
    task along a single selected path and adds the total to that path's first start date
    — there is no forward pass and no maximum taken at a merge point. Sampling is
    discrete: `getDuration` returns exactly the task's pessimistic, normal, or optimistic
    value, chosen by a uniform draw landing in one of three `EstimationRange` bands.
    [`MonteCarloCriticalPathBuilder.java`](https://github.com/LibrePlan/libreplan/blob/main/libreplan-webapp/src/main/java/org/libreplan/web/montecarlo/MonteCarloCriticalPathBuilder.java):
    `buildAllPossibleCriticalPaths()` enumerates paths through the network and then keeps
    only those whose every task is in the critical-path set (`isCriticalPath`), so
    non-critical tasks are discarded before any sampling happens. The screen simulates one
    named critical path at a time.

[^plcloud]: ProjectLibre Cloud is a proprietary SaaS product distinct from the
    CPAL-licensed ProjectLibre desktop, and lists "Monte Carlo Risk Analysis" among its
    advanced modeling and analytics features:
    <https://www.projectlibre.com/product/projectlibre-cloud>. Verified 2026-09-20.

[^taigaact]: Taiga release and repository activity:
    <https://github.com/taigaio/taiga-back>, <https://github.com/taigaio/taiga-front>,
    and the next-generation rewrite at
    <https://github.com/kaleidos-ventures/taiga>. Commit dates verified 2026-08-29.

[^op]: OpenProject, "Authentication FAQ" and "OpenID providers (Enterprise add-on)":
    <https://www.openproject.org/docs/system-admin-guide/authentication/authentication-faq/>,
    <https://www.openproject.org/docs/system-admin-guide/authentication/openid-providers/>.
    Verified 2026-07-03.

[^plane]: Plane, "Understanding Plane's editions" and self-hosting SSO docs:
    <https://developers.plane.so/self-hosting/editions-and-versions>,
    <https://developers.plane.so/self-hosting/govern/oidc-sso>. Verified 2026-07-03.

[^lean]: Leantime, open-source auth provider install and "Advanced Authentication"
    marketplace add-on (SAML):
    <https://marketplace.leantime.io/product/installation-auth-provider/>,
    <https://marketplace.leantime.io/product/advanced-auth/>. Verified 2026-07-03.

[^redmine]: Redmine, community OpenID Connect plugins (MIT-licensed, third-party) in
    the official plugin directory: <https://www.redmine.org/plugins/redmine_oidc>.
    Verified 2026-07-03.

[^taiga]: Taiga, community SAML / OpenID Connect authentication plugins (third-party,
    maintenance varies): <https://github.com/jgiannuzzi/taiga-contrib-saml-auth>.
    Verified 2026-07-03.
