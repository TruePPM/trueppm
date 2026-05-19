# Reddit Post Drafts

**Gating condition:** same as Show HN — #458–#463 must be live first.

---

## r/projectmanagement

**Title:** I built an open-source tool that finally bridges Agile and Waterfall on one task model — feedback welcome

I'm a software engineer who's worked inside large engineering organisations and watched the same pain repeat: the Scrum Master's Jira board and the Project Manager's Gantt chart never agree. The reconciliation happens in a spreadsheet, on Monday morning, by hand.

I've been building TruePPM to fix this. The core idea is that a single task should be both a sprint story and a WBS node — no translation, no copy-paste. The PM sees the Gantt with real CPM math (critical path, float, Monte Carlo risk dates). The team sees the board. Same data, different views.

It's early (0.1-alpha), self-hosted, Apache 2.0. The scheduling engine ships standalone on PyPI if you just want the math without the full app.

Happy to answer questions about the hybrid scheduling approach, the OSS/Enterprise split, or anything else.

Repo + docs: https://docs.trueppm.com

---

## r/opensource

**Title:** TruePPM – Apache 2.0 project scheduling with CPM + Monte Carlo (self-hosted, PyPI scheduler)

I've been building an open-core P3M (project/program/portfolio management) platform for teams that need real schedule math, not just task lists.

**OSS stack:** Django 5.1 + Channels, React 19 + Vite, PostgreSQL 16, Helm chart, WatermelonDB-compatible offline sync.

**The scheduling engine** (`trueppm-scheduler` on PyPI) is fully separable — pure Python, no Django dependency, MIT-friendly Apache 2.0. Use it standalone if you just need CPM/Monte Carlo.

**Open-core model:** community edition (this repo) is Apache 2.0 and fully functional for a PM and their team. Enterprise adds portfolio governance, SSO, cross-program resource leveling, and AI scheduling. The OSS core never imports from the enterprise repo.

Happy to discuss the architecture, the OSS/Enterprise boundary decisions, or take contribution questions.

Repo: https://gitlab.com/trueppm/trueppm | Docs: https://docs.trueppm.com

---

## Scheduling notes

- Post all three within the same 7-day window so links cross-reference
- Engage for 48h after each post — silence kills credibility faster than a mediocre post
- Do not post Show HN on a weekend; Tuesday–Thursday mornings (US ET) get better traction
