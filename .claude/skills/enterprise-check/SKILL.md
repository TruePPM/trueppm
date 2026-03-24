---
name: enterprise-check
description: >
  OSS vs Enterprise boundary classification for TruePPM features. Use when a new
  feature's classification is unclear before architecture is decided. Moving a feature
  between repos after implementation is painful — decide before writing code.
---

# Enterprise Check Skill

You are classifying a TruePPM feature as OSS (Apache 2.0, `trueppm-suite`) or
Enterprise (proprietary, `trueppm-enterprise`) before implementation begins.

## P3M Information Flow Model

TruePPM is structured around the PMI P3M information flow. Every feature belongs
to exactly one layer — use it as the first cut for OSS vs Enterprise.

```
Senior Leadership
    │ ← Portfolio performance information
    │ → Strategy
    ▼
Portfolios
    │ ← Performance information and progress
    │ → Desired outcomes, benefits, and value
    ▼
Programs and Projects
    │ ← Information for updates, fixes, and adjustments
    │ → Deliverables with support and maintenance information
    ▼
Operations
    └──────────────────────────────────────────────────────→
         Outcomes, Benefits, Value Performance Analysis
         (feeds back up to Senior Leadership)
```

**Layer → Repo mapping:**
| Layer | Scope | Repo |
|-------|-------|------|
| Senior Leadership | Org-wide strategy, board-level reporting | Enterprise |
| Portfolios | Cross-project dashboards, capacity, strategic alignment | Enterprise |
| Programs and Projects | Single-project scheduling, tasks, CPM, Gantt, Monte Carlo | **OSS** |
| Operations | Deliverable hand-off, maintenance tracking, time entries | **OSS** |

A feature that aggregates or compares data **across** projects (upward toward Portfolio)
belongs in Enterprise. A feature that operates **within** a single project belongs in OSS.

## Product Life Cycle Model

Projects don't exist in isolation — they serve a product moving through its life cycle.
Portfolio Governance spans the entire curve; Programs group related projects by phase.

```
Portfolio Governance  ──────────────────────────────────────────────────────────
  Program A (Introduction → Growth)      Program B (Maturity → Decline/Retirement)
  ┌────────────────────────────────┐      ┌────────────────────────────────────┐
  │ Project 1: Initial Creation    │      │ Project 4, 5, 6: Revisions         │
  │ Project 2: More Features       │      │   (concurrent, same phase)         │
  │ Project 3: Additions           │      │ Project 7: Retirement              │
  └────────────────────────────────┘      └────────────────────────────────────┘

Impact/Sales ▲
             │            ╭──────╮
             │         ╭──╯      ╰──╮
             │      ╭──╯            ╰──╮
             └──────────────────────────────▶ Time
          Introduction  Growth  Maturity  Decline
```

**What this means for OSS/Enterprise classification:**
- **Individual project** (Project 1, Project 5, etc.) → **OSS** — a PM needs to schedule it
- **Program** (Program A, Program B — grouping projects across phases) → **Enterprise**
- **Portfolio Governance** (the bar spanning everything) → **Enterprise**
- A feature that asks "which program does this project belong to?" → **Enterprise**
- A feature that asks "what's the schedule for this project?" → **OSS**
- Multiple projects running concurrently (Projects 4/5/6 in Maturity) is exactly
  the scenario that makes cross-project coordination an Enterprise concern

## Classification Rules

### OSS — goes in `trueppm-suite`
A feature belongs in the community edition if an **individual PM or small team**
would need it to manage a single project effectively.

OSS feature list (non-exhaustive):
- Scheduling: CPM, Monte Carlo, PERT estimates, calendars, baselines
- Task management: WBS hierarchy, dependencies (all 4 types), milestones
- Gantt chart (web + mobile)
- Time tracking and time entries
- 5-role RBAC (Owner, Admin, Scheduler, Member, Viewer)
- Real-time collaboration (WebSocket sync within a single project)
- Offline mobile (WatermelonDB sync)
- REST + WebSocket API
- MS Project import/export
- Helm chart, Docker Compose dev environment
- Basic reporting (project health, task list, critical path)
- Burn charts: burn down, burn up, combined burn (single-project/sprint scope)
- Risk register: risk model, CRUD, risk matrix (probability × impact), risk-to-task linkage, status lifecycle

### Enterprise — goes in `trueppm-enterprise`
A feature belongs in the enterprise edition if it requires **coordinating across
multiple projects, teams, or an entire organization**.

Enterprise feature list (non-exhaustive):
- Portfolio dashboard and health scores
- Demand intake and prioritization workspace
- Cross-project dependencies
- Resource leveling across projects
- CCPM (Critical Chain)
- Resource heat map (cross-portfolio)
- Schedule forensics and narrative reporting
- SSO / SAML / OIDC
- LDAP sync
- Immutable audit trail
- Custom roles (beyond the 5-role model)
- Approval workflows
- Integration hub (Jira, GitLab, ServiceNow)
- AI scheduling assistant
- Scenario modeling
- Portfolio-level Monte Carlo
- Multi-tenancy
- HA deployment configuration
- Portfolio risk rollup (aggregated risk across projects)
- Cross-project risk propagation
- Risk-triggered approval workflows
- Burn charts at portfolio/program level (cross-project scope)

## Boundary Rules

These rules are **non-negotiable**:

1. `trueppm-suite` code must NEVER import from `trueppm_enterprise`
   - Verify: `grep -r "trueppm_enterprise" packages/` must return zero results
2. Enterprise code may import from OSS (dependency is one-way: enterprise → core)
3. Extension points (settings, URL patterns, signal hooks) must remain stable;
   enterprise registers against them without OSS knowing
4. The community edition must be **fully functional** without the enterprise package

## Decision Framework

Ask in order:
1. **Which P3M layer does this feature serve?**
   - Senior Leadership or Portfolios → Enterprise
   - Programs and Projects or Operations → OSS
2. Does this feature require data from more than one project? → Enterprise
3. Does this feature require org-level admin (not project-level)? → Enterprise
4. Would a freelance PM using the free tier miss this? → OSS
5. Is this a compliance, audit, or governance feature? → Enterprise
6. Is it a core scheduling algorithm? → OSS (scheduling is TruePPM's OSS differentiator)

## Output Format

State the classification: **OSS** or **Enterprise**, then explain in 2-3 sentences why.

If the feature straddles the boundary (e.g., an OSS hook + enterprise implementation):
```
OSS: Define the extension point (signal / plugin hook / settings include)
Enterprise: Implement the feature against that hook
```

List any ADR implications — if this decision requires an architecture change, flag it
so the `architect` skill is invoked before implementation.
