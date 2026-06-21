"""Django signals for the workspace app.

The ``audit_event_created`` signal is the OSS extension point for the Enterprise
operational-audit layer (immutable/signed storage, retention policy, SOC-2
export). Enterprise receivers connect via their own ``AppConfig.ready()`` without
modifying OSS code — OSS never imports ``trueppm_enterprise`` (ADR-0157, #859).

Usage (Enterprise side, never imported by OSS)::

    # trueppm_enterprise/audit/apps.py
    def ready(self):
        from trueppm_api.apps.workspace.signals import audit_event_created
        audit_event_created.connect(immutable_audit_receiver)

.. warning::
    The signal is emitted from ``transaction.on_commit()`` so a receiver only
    ever sees a committed ``AuditEvent`` row (no phantom events on rollback).
    Receivers that perform further I/O (HTTP calls, cross-DB writes) own the
    durability of that downstream work.
"""

from __future__ import annotations

import django.dispatch

# Sent after an AuditEvent row is committed (ADR-0157, #859). This is the stable
# seam Enterprise registers against to layer immutable/signed/SOC-2 storage on
# top of the OSS event stream.
#
# Keyword arguments (payload schema is STABLE — do not change):
#   sender       — the AuditEvent class
#   audit_event  — the committed AuditEvent instance
#
# Fired via record_audit_event() using transaction.on_commit + send_robust, so a
# raising enterprise receiver is swallowed-and-logged and can never break the OSS
# write path. OSS connects no receiver.
audit_event_created = django.dispatch.Signal()
