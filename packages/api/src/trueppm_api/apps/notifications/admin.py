"""Django admin registration for notifications models."""

from django.contrib import admin

from .models import Mention, Notification, NotificationPreference


@admin.register(Mention)
class MentionAdmin(admin.ModelAdmin):
    list_display = (
        "id",
        "mentioner",
        "mentioned_user",
        "mentioned_group_key",
        "scope",
        "created_at",
    )
    list_filter = ("scope", "created_at")
    search_fields = ("mentioner__username", "mentioned_user__username", "mentioned_group_key")
    readonly_fields = ("id", "created_at")


@admin.register(Notification)
class NotificationAdmin(admin.ModelAdmin):
    list_display = (
        "id",
        "recipient",
        "project",
        "is_read",
        "is_archived",
        "email_pending",
        "created_at",
    )
    list_filter = ("is_read", "is_archived", "email_pending", "created_at")
    search_fields = ("recipient__username",)
    readonly_fields = ("id", "created_at", "read_at", "email_sent_at", "email_failed_at")


@admin.register(NotificationPreference)
class NotificationPreferenceAdmin(admin.ModelAdmin):
    list_display = ("user", "event_type", "channel", "enabled", "updated_at")
    list_filter = ("event_type", "channel", "enabled")
    search_fields = ("user__username",)
