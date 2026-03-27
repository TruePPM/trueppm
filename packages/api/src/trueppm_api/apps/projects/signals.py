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
