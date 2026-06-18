---
name: enterprise-check
model: sonnet
description: >
  OSS vs Enterprise boundary classification for TruePPM features. Use when a new
  feature's classification is unclear before architecture is decided. Moving a feature
  between repos after implementation is painful — decide before writing code.
---

# Enterprise Check Skill

You are classifying a TruePPM feature as OSS (Apache 2.0, `trueppm-suite`) or
Enterprise (proprietary, `trueppm-enterprise`) before implementation begins.

## P3M Information Flow Model

TruePPM is structured around the P3M (project, program, portfolio management) information flow. Every feature belongs
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
| Portfolios | Cross-program dashboards, capacity, strategic alignment | Enterprise |
| Programs and Projects | Scheduling, tasks, CPM, program management (coordinating projects within a program) | **OSS** |
| Operations | Deliverable hand-off, maintenance tracking, time entries | **OSS** |

The OSS unit is the **program** — a set of related projects managed by one PM or program manager. The Enterprise unit is the **portfolio** — coordination across multiple programs at an organizational level.

A feature that aggregates or compares data **across programs** (upward toward Portfolio) belongs in Enterprise. A feature that operates **within a program** (one or more related projects) belongs in OSS.

> **Adoption lens (read this before applying the rule above strictly):**
> "Cross-project" alone is not the test — **governance** is. A solo PM or small team
> with three active projects who can't put them on a single read-only timeline goes
> to Asana, Linear, Notion, or MS Project — all of which show multiple projects in a
> free tier. Forcing the *basic* multi-project view into Enterprise blocks the buyer
> from ever feeling value, which kills the upsell motion entirely.
>
> The clean line is **basic multi-project viewing (OSS)** vs **governance on top of
> it (Enterprise)**. Health scores, P80 forecasts, baselines, cross-project
> dependency arrows, scenario modeling, demand intake, policy enforcement, audit
> trail, sign-off ceremonies — all governance. The OSS version anchors adoption;
> the Enterprise version is what an *organization* needs once the tool is embedded.

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
- **Program** (Program A, Program B — grouping related projects) → **OSS** — a program manager coordinating multiple projects within one delivery initiative needs this
- **Portfolio Governance** (the bar spanning multiple programs) → **Enterprise**
- A feature that asks "what's the schedule or status for projects in this program?" → **OSS**
- A feature that asks "how are all our programs performing against portfolio strategy?" → **Enterprise**
- Multiple projects running concurrently within a program (Projects 4/5/6 in Maturity) → **OSS** (same program manager, one delivery initiative)
- Coordinating across Programs A and B simultaneously (portfolio-level) → **Enterprise**

## Classification Rules

### OSS — goes in `trueppm-suite`
A feature belongs in the community edition if an **individual PM or small team**
would need it to manage their work effectively — including viewing multiple of
their own projects together at a basic level.

OSS feature list (non-exhaustive):
- Scheduling: CPM, Monte Carlo (capped), PERT estimates, calendars, baselines
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
- **Basic multi-project viewing** — projects-as-swimlanes timeline, shared milestone
  markers, today line, basic anonymous read-only sharing links. **Read-only**, **no
  governance overlay**. The executive narrative (health colors, P80 markers,
  baselines, dep arrows, scenario integration) is Enterprise.
- **Basic project setting templates** — copy settings from another project, optional
  default-from-program-parent. **Manual** override per project. Policy-enforced
  inheritance with locks is Enterprise.
- **Outbound integration extension points** — task carries external URL with
  on-demand preview, board posts one-way events to webhook URL, user opts into
  SMTP notifications. Read-on-demand pulls from external systems are also OK
  here (e.g. fetch current Jira state when a linked task opens). Webhook ingest,
  bidirectional sync workers, OAuth flows, and conflict resolution are Enterprise.

### Enterprise — goes in `trueppm-enterprise`
A feature belongs in the enterprise edition if it requires **portfolio-level coordination
across multiple programs, or organizational governance on top of program-level work**.

Enterprise feature list (non-exhaustive):
- Portfolio dashboard and health scores
- Demand intake and prioritization workspace
- Cross-program coordination and dependencies
- Resource leveling across programs (portfolio scope)
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
- Burn charts at portfolio level (cross-program scope)
- Risk register: risk matrix visualization, risk-to-task linkage, severity scoring (OSS has basic CRUD only)
- Monte Carlo: unlimited simulations and tasks, sensitivity analysis, confidence intervals (OSS has capped simulation only)
- Custom fields / custom attributes on tasks and projects (org-specific metadata)
- Guest / external stakeholder access — **managed-guest compliance only**: audit trail of guest access, guest-account lifecycle governance, and access-review evidence. OSS already ships the basic permission-limited guest itself (`MemberStatus.GUEST` membership plus the `Workspace.allow_guests` toggle, with no audit trail) alongside anonymous read-only share links. The Enterprise piece is solely the audit-trail / compliance layer on top, not the guest capability.
- **Executive multi-project Roadmap** — health-colored project bars, P80 markers,
  baseline shadow bars, inter-project dependency arrows, scenario integration,
  program swimlanes, board-deck PNG export. (OSS has the basic timeline; this is
  the governance overlay.)
- **Policy-enforced setting inheritance** — program admin locks settings as policy
  in child projects, audit trail of policy changes, override flag governance. (OSS
  has manual setting templates; this is the lock + audit layer.)
- **Bidirectional integration sync** — webhook ingest with HMAC verification and
  replay protection, OAuth flows, conflict resolution policy, reconciliation loop,
  per-tenant rate-limit budgets, audit trail of every inbound/outbound mutation.
  (OSS has outbound + read-on-demand; this is the durable two-way machinery.)
- Advanced report builder (custom queries, scheduled PDF delivery, executive templates)
- White-label / custom domain (consulting firms branding the tool for clients)
- Data retention policy controls (7-year archive, GDPR deletion workflows)
- Priority support / SLA tiers (guaranteed response times)
- Mobile: GPS-verified time entry (location-stamped timesheets for compliance)
- Mobile: photo and file attachments from camera (attach site photos to tasks)
- Mobile: offline CPM simulation (WASM scheduling engine running on-device without connectivity)
- Mobile: smart push notifications with critical path intelligence (CP change, milestone slip, risk review due)
- Mobile: daily standup digest (auto-generated morning briefing pushed to device)

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
1. **Adoption test (run first):** if this feature is missing from the OSS edition,
   does the prospect bounce to Asana / Linear / Notion / MS Project before they
   can feel value? If yes, the feature (or a *basic* version of it) belongs in
   OSS regardless of the layer. The Enterprise upsell sits *on top* of the OSS
   anchor, not in front of it.
2. **Governance test:** does the feature add health scoring, audit trail, sign-off,
   policy enforcement, scenario modeling, P80/baseline comparison, locked
   inheritance, or compliance-grade record-keeping? → **Enterprise**
3. **Which P3M layer does this feature serve?**
   - Senior Leadership or Portfolios → Enterprise (unless the OSS adoption test
     applies — basic multi-project viewing for an individual PM passes step 1)
   - Programs and Projects or Operations → OSS
4. Does this feature require data from more than one project?
   - Within a single **program** (one PM/program manager, related projects) → OSS
   - Across **multiple programs** (portfolio governance, org-level coordination) → Enterprise
5. Does this feature require org-level admin (not project- or program-level)? → Enterprise
6. Would a freelance PM using the free tier miss this? → OSS
7. Is this a compliance, audit, or governance feature? → Enterprise
8. Is it a core scheduling algorithm? → OSS (scheduling is TruePPM's OSS differentiator)
9. Does it require durable two-way machinery (webhook ingest, OAuth flows, conflict
   resolution, reconciliation loops, audit trail of inbound events)? → Enterprise

## Output Format

State the classification: **OSS** or **Enterprise**, then explain in 2-3 sentences why.

If the feature straddles the boundary (e.g., an OSS hook + enterprise implementation):
```
OSS: Define the extension point (signal / plugin hook / settings include)
Enterprise: Implement the feature against that hook
```

If the feature is a **basic-vs-governance split** (the most common case for
adoption-sensitive features), call out both sides explicitly with their
non-goals:
```
OSS basic version: <what an individual PM gets, with explicit non-goals>
Enterprise governance version: <what an organization gets on top — health,
audit, P80, baselines, locks, scenario, durable sync, etc.>
```

List any ADR implications — if this decision requires an architecture change, flag it
so the `architect` skill is invoked before implementation.
