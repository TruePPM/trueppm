"""Signal receivers for the notifications app (ADR-0075).

Notification fan-out (mention → per-user Notification rows) is wired through
explicit service functions called from the comment viewset rather than from
signals, so the call site is reviewable and the transaction boundary is
obvious. This module exists for the AppConfig.ready() hook and to host any
cross-app receivers that need to land here later (e.g. user-create →
backfill NotificationPreference defaults).
"""

# Intentionally empty for the 0.2 initial drop. Receivers will be added in
# the services + viewsets implementation slice.
