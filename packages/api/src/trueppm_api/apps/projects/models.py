"""Core project scheduling domain models."""

from __future__ import annotations

import uuid

from django.db import models

from trueppm_api.fields import LtreeField


class VersionedModel(models.Model):
    """Abstract base for all models that participate in offline sync.

    server_version is a monotonically increasing integer incremented on every
    save. The mobile sync protocol uses it to detect changes since a given
    checkpoint without needing created_at/updated_at timestamps.

    Concurrency safety: server_version is updated via F() expression in an
    atomic update() call, so concurrent writes produce a strict order rather
    than a lost-update race.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    server_version = models.BigIntegerField(default=0, editable=False)

    class Meta:
        abstract = True

    def save(self, *args: object, **kwargs: object) -> None:
        # Increment server_version atomically on every update.
        if self.pk and type(self).objects.filter(pk=self.pk).exists():
            type(self).objects.filter(pk=self.pk).update(
                server_version=models.F("server_version") + 1
            )
            self.server_version = (
                type(self).objects.values_list("server_version", flat=True).get(pk=self.pk)
            )
            # Exclude server_version from the subsequent UPDATE so super().save()
            # does not overwrite the increment applied above via F() expression.
            if kwargs.get("update_fields") is not None:
                kwargs["update_fields"] = [
                    f for f in kwargs["update_fields"] if f != "server_version"
                ]
            else:
                kwargs["update_fields"] = [
                    f.attname
                    for f in self._meta.concrete_fields
                    if not f.primary_key and f.attname != "server_version"
                ]
        super().save(*args, **kwargs)


# ---------------------------------------------------------------------------
# Calendar
# ---------------------------------------------------------------------------


class Calendar(VersionedModel):
    """Working calendar definition.

    Defines which days of the week are working days and hours per day.
    Exception date ranges (holidays, shutdowns) live in CalendarException.
    """

    name = models.CharField(max_length=255)
    # Bitmask: Mon=1, Tue=2, Wed=4, Thu=8, Fri=16, Sat=32, Sun=64
    working_days = models.SmallIntegerField(
        default=31,  # Mon–Fri
        help_text="Bitmask of working days: Mon=1, Tue=2, Wed=4, Thu=8, Fri=16, Sat=32, Sun=64",
    )
    hours_per_day = models.FloatField(default=8.0)
    timezone = models.CharField(max_length=64, default="UTC")

    class Meta:
        db_table = "projects_calendar"

    def __str__(self) -> str:
        return self.name


class CalendarException(models.Model):
    """A non-working date range (holiday, shutdown) within a calendar."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    calendar = models.ForeignKey(Calendar, on_delete=models.CASCADE, related_name="exceptions")
    exc_start = models.DateField()
    exc_end = models.DateField()
    description = models.CharField(max_length=255, blank=True)

    class Meta:
        db_table = "projects_calendar_exception"

    def __str__(self) -> str:
        return f"{self.calendar} exception {self.exc_start} to {self.exc_end}"


# ---------------------------------------------------------------------------
# Project
# ---------------------------------------------------------------------------


class Project(VersionedModel):
    """A project — the top-level container for tasks and scheduling."""

    name = models.CharField(max_length=255)
    description = models.TextField(blank=True)
    start_date = models.DateField()
    calendar = models.ForeignKey(
        Calendar,
        on_delete=models.PROTECT,
        related_name="projects",
        null=True,
        blank=True,
    )

    class Meta:
        db_table = "projects_project"
        ordering = ["start_date", "name"]

    def __str__(self) -> str:
        return self.name


# ---------------------------------------------------------------------------
# Task
# ---------------------------------------------------------------------------

DEPENDENCY_TYPE_CHOICES = [
    ("FS", "Finish-to-Start"),
    ("SS", "Start-to-Start"),
    ("FF", "Finish-to-Finish"),
    ("SF", "Start-to-Finish"),
]


class Task(VersionedModel):
    """A schedulable unit of work within a project.

    CPM output fields (early_start through is_critical) are written by the
    Celery scheduling task after running the trueppm_scheduler engine. They
    are read-only from the REST API perspective.

    wbs_path is a PostgreSQL ltree value (e.g. "1.2.3") for WBS hierarchy,
    indexed with GiST for fast subtree and ancestor queries.
    """

    project = models.ForeignKey(Project, on_delete=models.CASCADE, related_name="tasks")
    name = models.CharField(max_length=512)
    wbs_path = LtreeField(
        help_text="WBS hierarchy path in ltree format, e.g. '1.2.3'",
        null=True,
        blank=True,
    )
    # Duration in working days — mirrors trueppm_scheduler.Task.duration.days
    duration = models.IntegerField(default=1, help_text="Duration in working days")
    percent_complete = models.FloatField(default=0.0)
    notes = models.TextField(blank=True)

    # CPM output fields — populated by the scheduling Celery task
    early_start = models.DateField(null=True, blank=True)
    early_finish = models.DateField(null=True, blank=True)
    late_start = models.DateField(null=True, blank=True)
    late_finish = models.DateField(null=True, blank=True)
    total_float = models.IntegerField(
        null=True, blank=True, help_text="Total float in working days"
    )
    free_float = models.IntegerField(null=True, blank=True, help_text="Free float in working days")
    is_critical = models.BooleanField(null=True, blank=True)

    # Three-point PERT estimates (optional; used by Monte Carlo if present)
    optimistic_duration = models.IntegerField(null=True, blank=True)
    most_likely_duration = models.IntegerField(null=True, blank=True)
    pessimistic_duration = models.IntegerField(null=True, blank=True)

    class Meta:
        db_table = "projects_task"
        ordering = ["wbs_path", "name"]
        indexes = [
            models.Index(fields=["project"]),
        ]

    def __str__(self) -> str:
        return f"{self.project.name} / {self.name}"


# ---------------------------------------------------------------------------
# Dependency
# ---------------------------------------------------------------------------


class Dependency(models.Model):
    """A scheduling dependency between two tasks."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    predecessor = models.ForeignKey(Task, on_delete=models.CASCADE, related_name="successors")
    successor = models.ForeignKey(Task, on_delete=models.CASCADE, related_name="predecessors")
    dep_type = models.CharField(max_length=2, choices=DEPENDENCY_TYPE_CHOICES, default="FS")
    lag = models.IntegerField(
        default=0,
        help_text="Lag in calendar days (positive = delay, negative = lead)",
    )

    class Meta:
        db_table = "projects_dependency"
        constraints = [
            models.UniqueConstraint(
                fields=["predecessor", "successor", "dep_type"],
                name="unique_dependency",
            )
        ]

    def __str__(self) -> str:
        return f"{self.predecessor} {self.dep_type}+{self.lag}d {self.successor}"
