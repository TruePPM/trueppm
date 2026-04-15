"""Resource domain models."""

from __future__ import annotations

import uuid

from django.db import models

from trueppm_api.apps.projects.models import Calendar, Task, VersionedModel


class Resource(VersionedModel):
    """A person, team, or material that can be assigned to tasks."""

    name = models.CharField(max_length=255)
    email = models.EmailField(blank=True)
    calendar = models.ForeignKey(
        Calendar,
        on_delete=models.PROTECT,
        related_name="resources",
        null=True,
        blank=True,
    )
    # Maximum availability as a fraction of full-time (1.0 = 100%, 0.5 = 50%)
    max_units = models.DecimalField(max_digits=4, decimal_places=2, default=1.0)

    class Meta:
        db_table = "resources_resource"
        ordering = ["name"]

    def __str__(self) -> str:
        return self.name


class TaskResource(models.Model):
    """Many-to-many through table for task–resource assignments."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    task = models.ForeignKey(Task, on_delete=models.CASCADE, related_name="assignments")
    resource = models.ForeignKey(
        Resource, on_delete=models.CASCADE, related_name="assignments", db_index=True
    )
    # Units assigned as a fraction of full-time (mirrors max_units on Resource)
    units = models.DecimalField(max_digits=4, decimal_places=2, default=1.0)

    class Meta:
        db_table = "resources_task_resource"
        unique_together = [("task", "resource")]

    def __str__(self) -> str:
        return f"{self.resource} on {self.task} ({self.units}u)"

    @property
    def project_id(self) -> object:
        """Expose the task's project_id so _get_project_id_from_obj can find it.

        Required for CanAssignResource.has_object_permission to resolve the project
        context from a TaskResource instance without a direct FK to Project.
        """
        return self.task.project_id
