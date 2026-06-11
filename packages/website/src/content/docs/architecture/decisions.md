---
title: Architecture Decision Records
description: Where to find the canonical ADRs for TruePPM.
---

TruePPM keeps Architecture Decision Records (ADRs) at the source-of-record location in the monorepo, not in this docs site. ADRs change often during early development; mirroring them here would constantly drift.

## Where the ADRs live

📖 **[`docs/adr/` on GitLab](https://gitlab.com/trueppm/trueppm/-/tree/main/docs/adr)**

Each ADR is a markdown file using the [Michael Nygard format](https://github.com/joelparkerhenderson/architecture-decision-record/blob/main/locales/en/templates/decision-record-template-by-michael-nygard/index.md). The numbering is monotonic; status (`Proposed`, `Accepted`, `Deprecated`, `Superseded`) is in each ADR's "## Status" section.

## Headline decisions

The ADRs most worth reading first if you are evaluating TruePPM:

- **ADR-0011** — Object change history (django-simple-history, configurable retention — default 90 days)
- **ADR-0013** — Board / Kanban view: data model, API, and integration design
- **ADR-0027** — Incremental CPM recompute (subgraph delta strategy)
- **ADR-0030** — Project navigation shell (tab order, landing surface)
- **ADR-0035** — Board PPM signals (CP, blocked, risk, EVM annotations)
- **ADR-0036** — Hybrid PM philosophy and the sprint model — *the wedge document; pairs with [The Story](/the-story/)*
- **ADR-0037** — Sprint model: data, API, board integration
- **ADR-0040** — Schedule view: bar/drawer/gutter
- **ADR-0041** — Project [methodology preset](/features/methodology-preset/) (tab visibility per planning model)

## Why ADRs?

Decisions matter more than code; code can change in a refactor, but the *why* is gone unless captured. ADRs prevent re-litigating the same trade-offs every quarter and give new contributors a way to understand the system without interrogating its authors.
