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
1. Does this feature require data from more than one project? → Enterprise
2. Does this feature require org-level admin (not project-level)? → Enterprise
3. Would a freelance PM using the free tier miss this? → OSS
4. Is this a compliance, audit, or governance feature? → Enterprise
5. Is it a core scheduling algorithm? → OSS (scheduling is TruePPM's OSS differentiator)

## Output Format

State the classification: **OSS** or **Enterprise**, then explain in 2-3 sentences why.

If the feature straddles the boundary (e.g., an OSS hook + enterprise implementation):
```
OSS: Define the extension point (signal / plugin hook / settings include)
Enterprise: Implement the feature against that hook
```

List any ADR implications — if this decision requires an architecture change, flag it
so the `architect` skill is invoked before implementation.
