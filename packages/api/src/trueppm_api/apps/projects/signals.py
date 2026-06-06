"""Django signals for the projects app.

The ``risk_changed`` signal is the OSS extension point for Enterprise
portfolio risk rollup. Enterprise receivers connect via their own
AppConfig.ready() without modifying OSS code.

Usage (Enterprise side, never imported by OSS)::

    # trueppm_enterprise/portfolio_risks/apps.py
    def ready(self):
        from trueppm_api.apps.projects.signals import risk_changed
        risk_changed.connect(portfolio_risk_rollup_receiver)

.. warning::
    The signal is emitted synchronously inside the database transaction.
    Enterprise receivers that perform I/O (HTTP calls, cross-DB writes) **must**
    defer those side-effects with ``transaction.on_commit()`` to avoid blocking
    the transaction or writing to external systems on a rolled-back save.
"""

from __future__ import annotations

import django.dispatch

# Sent after a Risk is saved or soft-deleted.
#
# Keyword arguments:
#   sender  — the Risk class
#   risk    — the Risk instance (post-save state)
#   action  — "saved" | "deleted"
#
# Only emitted when probability, impact, or status changes on save.
# For soft-deletes, ``action="deleted"`` is sent by Risk.soft_delete()
# and the save() emission is suppressed (is_deleted is already True).
risk_changed = django.dispatch.Signal()

# Sent after a Task's status field changes (board card drag or direct API update).
#
# Keyword arguments:
#   sender     — the Task class
#   task       — the Task instance (post-save state)
#   old_status — previous TaskStatus value (None on first save / INSERT)
#   new_status — new TaskStatus value
#
# Only emitted when the status value actually changes. CPM bulk_update bypasses
# Task.save() so this signal never fires for scheduling engine writes.
# Enterprise receivers must use transaction.on_commit() for any I/O side-effects.
task_status_changed = django.dispatch.Signal()

# Sent after a SprintScopeChange row is created (ADR-0060 #308, generalized in
# ADR-0101 §5 / ADR-0102). Fires when *any* task is linked to a task's ACTIVE
# sprint mid-sprint — the original subtask-spawn path, plus the direct
# "assign existing task to the active sprint" path. The row enters the pending
# state (ADR-0102): excluded from commitment/burndown until a team member with
# the sprint-lifecycle gate accepts or rejects it.
#
# Keyword arguments:
#   sender          — the SprintScopeChange class
#   scope_change    — the SprintScopeChange instance (post-save)
#   task            — the Task whose sprint membership changed (the injected item)
#
# OSS only emits; Enterprise registers receivers via AppConfig.ready().
# Receivers that perform I/O must use transaction.on_commit() to avoid
# blocking the transaction or writing on rollback.
#
# ADR-0102 §3 invariant: this signal is *notify-only*. No receiver may flip a
# SprintScopeChange.status away from PENDING — accept/reject are exclusively the
# human-invoked service functions (accept_scope_change / reject_scope_change).
sprint_scope_changed = django.dispatch.Signal()

# Sent after a bound milestone is reforecast (ADR-0106 §6, #860). This is the
# one OSS read-only seam the Enterprise cross-team forecast mirrors (#140/#141/
# #142, 1.0) register against. OSS itself never aggregates across teams.
#
# Keyword arguments (band + dates ONLY — never the velocity series, never any
# per-contributor data):
#   sender               — the ForecastSnapshot class
#   project_id           — the project UUID (str)
#   milestone_id         — the bound milestone Task UUID (str)
#   cpm_finish           — ISO date str | None (the deterministic CPM spine)
#   p50                  — ISO date str | None
#   p80                  — ISO date str | None
#   confidence           — "high" | "medium" | "low"
#   unmodeled_dependency — bool (§4 cheap predecessor heuristic)
#
# Privacy (ADR-0106 §6): the signal fires for OSS's own forecast-history needs
# unconditionally, but the *cross-team-eligible* projection of it is supplied
# only through the consent-respecting provider in the Unified Team-Signal Privacy
# Model — the Enterprise receiver must consult the consent record; OSS never does
# the aggregation. Receivers performing I/O must use transaction.on_commit().
milestone_forecast_recomputed = django.dispatch.Signal()
