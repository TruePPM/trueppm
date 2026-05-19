# Show HN Draft

**Gating condition:** #458 #459 #460 #462 #463 all merged and live on docs.trueppm.com.

---

**Title:** Show HN: TruePPM – Apache 2.0 P3M that bridges Agile and Waterfall on one task model

**Body:**

I've been building TruePPM for the past year — an open-source project and program management platform that bridges Agile sprint cadence with waterfall Critical Path Method scheduling.

The core idea: every task is simultaneously a WBS node (with CPM-computed early/late start, float, critical path) and a sprint story (with story points, sprint assignment, burndown). No translation layer, no reconciliation spreadsheet. The Scrum Master sees the board; the Project Manager sees the Gantt; they're looking at the same data.

**What's shipped in 0.1-alpha:**
- CPM engine: forward/backward pass, all 4 dependency types, calendar-aware lag, cycle detection. Ships as `trueppm-scheduler` on PyPI (no Django dependency).
- Monte Carlo: PERT-Beta distributions, P50/P80/P95 dates, ~10k runs/sec with numpy
- Sprints: plan/activate/close, burndown, velocity, capacity preflight, retrospective-to-backlog
- Board + Gantt: real-time WebSocket updates on every mutation, offline-first delta sync
- 5-role RBAC: Owner / Admin / Scheduler / Member / Viewer on every endpoint and UI surface
- Helm chart: Kubernetes deployment via GHCR OCI registry
- Self-hosted: Docker Compose for dev, production stack with TLS

**5-minute local demo:**
```
git clone https://gitlab.com/trueppm/trueppm.git && cd trueppm
docker compose up -d
docker compose exec api python manage.py seed_demo_project --with-personas
```

The scheduler is also usable standalone: `pip install trueppm-scheduler`

**What I'm working on next (0.2):** velocity feedback loop (sprint velocity → CPM duration suggestions), program backlog (intake pool across related projects), and the "My Work" contributor surface.

Repo: https://gitlab.com/trueppm/trueppm
Docs: https://docs.trueppm.com

---

**Pre-flight checklist before posting:**
- [ ] docs.trueppm.com loads without auth from an incognito browser
- [ ] About page live with maintainer identity
- [ ] GitLab milestones page public
- [ ] At least 10 open issues with labels and milestones
- [ ] Maintainer has 48h bandwidth to engage with comments
