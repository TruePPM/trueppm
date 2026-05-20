"""Notifications app — Mention, Notification, NotificationPreference.

Implements the unified @mention and notification surface designed in ADR-0075.
The same Mention/Notification rows back both TaskComment mentions (this MR,
#311) and future TaskNote mentions (#476). The MentionScope enum stubs the
visibility gate that #476 will extend for team-private Decisions.
"""
