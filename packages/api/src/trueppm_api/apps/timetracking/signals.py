"""Extension signals for timesheet review (ADR-1495 §5).

``timesheet_review_changed`` fires after every review transition (submit, withdraw,
approve, return). It is an OSS->Enterprise extension point: an Enterprise receiver
may layer org governance on top (payroll export, audit retention), never a second
approver inside OSS. Dispatched with ``dispatch_extension_signal()`` so a receiver
that raises cannot break the OSS write, and its payload is identifiers and scalars
only — receivers must treat them as untrusted.

Payload: ``submission_id``, ``user_id``, ``week_start`` (ISO string),
``from_status``, ``to_status``, ``actor_id``.
"""

from __future__ import annotations

import django.dispatch

timesheet_review_changed = django.dispatch.Signal()
