"""Teams app (ADR-0078, OSS) — the Scrum team that owns a sprint commitment.

0.3 minimal slice (#927): the ``Team`` entity with one auto-created default team
per project, plus ``TeamMembership`` carrying the two-axis model — an ordinal
access role (Member/Admin) and two independent facets (``is_scrum_master``,
``is_product_owner``). Multi-team UX, sprint/task team binding, and the MCP
per-team opt-in stay in #599 (0.6).
"""
