---
title: How TruePPM Compares
description: Named, dated comparison against the open-source PPM field and the commercial scheduling tools — including the head-to-heads TruePPM loses.
documentedFor: "0.4"
---

This page names competitors and cites sources. It also names the comparisons TruePPM
**loses**, because a comparison page that only lists wins is an advertisement, and you
should not make a tooling decision on an advertisement.

:::caution[Read the version status first]
TruePPM is pre-GA. The current shipped release is an alpha, and the first beta is
0.4. Every claim below about TruePPM's own capabilities describes what is in `main`
today, unless marked otherwise. The [roadmap](/overview/roadmap/) is the
authoritative Shipped / Underway / Planned record.
:::

:::note[Ships in 0.4]
Two capabilities compared on this page — the **read-only MCP server** and **OIDC /
OAuth2 login** — ship in 0.4, TruePPM's first beta, and are not in the latest tagged
release. On the current release neither is available: you authenticate with local
accounts, and there is no MCP endpoint to point a client at. Every other TruePPM
claim on this page describes what is in `main` today.
:::

:::note[How to read the claims here]
The SSO/auth comparisons below carry dated, linked footnotes, because vendor
packaging changes and a stale citation is worse than none — re-verify against the
linked source before quoting one. The rest of the claims in both tables reflect our
own reading of each vendor's public documentation and product pages; they are not
individually dated and footnoted, so treat them as directionally correct rather than
independently audited. Claims about TruePPM's own capabilities are checkable against
the [engine package](https://pypi.org/project/trueppm-scheduler/) and the
[tested scale envelope](/administration/sizing/#tested-envelope). If a row here is
wrong, [open an issue](https://gitlab.com/trueppm/trueppm/-/issues) and we will
correct it.
:::

## The one-sentence version

TruePPM is the only open-source PPM platform we are aware of that ships **Monte Carlo
schedule risk analysis**, and the only PPM tool of any kind — open or commercial — we
are aware of whose **scheduling engine you can install and audit by itself**. It is
*not* a Primavera P6 or MS Project replacement, because it has no resource leveling
and one constraint type.

## Against the open-source field

| | CPM with float | Monte Carlo | Agile board coupled to the schedule | Engine installable standalone | OIDC/OAuth login in the free core | MCP server in the free core |
|---|---|---|---|---|---|---|
| **TruePPM** | Yes | **Yes** | **Yes — same object** | **Yes** (`pip install trueppm-scheduler`) | **Yes** (ships in 0.4) [^sso] | **Yes** (ships in 0.4, read-only) |
| OpenProject | Gantt with dependencies; **no critical path** [^opcp] | No | Board and Gantt as adjacent views | No | Enterprise add-on [^op] | Enterprise add-on [^opmcp] |
| Redmine | Via third-party plugins | No | No | No | Third-party plugin [^redmine] | No |
| Plane | No | No | Agile-only | No | Paid / Commercial editions [^plane] | No |
| Taiga | No | No | Agile-only | No | Third-party plugin [^taiga] | No |
| Leantime | No | No | No | No | Yes — free in the core [^lean] | No |
| ProjectLibre / GanttProject | Yes (desktop) | No | No | No | n/a — desktop, no server auth | No |

Three things this table is really saying:

**Monte Carlo is the empty column.** Probabilistic schedule risk is absent from the
entire open-source PPM field. That is TruePPM's sharpest single differentiator and
the easiest one to verify — install the engine and run it.

**The agile/waterfall split is a real fork, and most tools pick a side.** Plane and
Taiga are agile-only; ProjectLibre and GanttProject are schedule-only. OpenProject
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
| Custom work-item types and statuses | Unlimited, per project | **No** — six fixed statuses; board columns can be renamed, reordered, hidden and WIP-capped, but not added |
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
measured limits — a project stays comfortable in the Schedule view to roughly 1,000
tasks today.

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
| **Resource leveling** | **No** | Yes | Yes |
| **Constraint types** | **1** (start-no-earlier-than) | Full set | 8 + deadlines |
| **Cost / earned value** | **No** (EV-lite planned 0.8) | Yes | Yes |
| **Tested task ceiling** | **~1,000 in the Schedule view** | Very large (100k+ activities in practice) | Large |
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
point, and it is checkable from each vendor's own product pages.

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
one-way Jira sync into My Work ships in 0.4 so contributors never double-enter, and a
one-time migration import follows in 0.5 for teams that decide to move. Run both and
get the CPM forecast without asking anyone to change tools first.

Where Jira wins and will keep winning: ecosystem, marketplace, integration breadth,
and developer familiarity. TruePPM's plugin architecture is planned for 0.7 and a
public Extension SDK for 0.9.

## Related

- [What TruePPM doesn't do yet](/overview/what-it-does-not-do/) — the maintained gap list
- [SSO is not an enterprise feature](/overview/sso-is-not-enterprise/) — the full SSO-tax comparison, cited
- [Computed, not guessed](/overview/computed-not-guessed/) — why the engine, not a model, answers
- [Roadmap](/overview/roadmap/) — the authoritative Shipped / Underway / Planned record

[^sso]: Basic OIDC / OAuth2 login federation ships in the OSS core at 0.4. See
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
