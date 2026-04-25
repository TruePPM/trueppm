"""Resource domain models."""

from __future__ import annotations

import uuid

from django.db import models

from trueppm_api.apps.projects.models import Calendar, Project, Task, VersionedModel


class Resource(VersionedModel):
    """A person, team, or material that can be assigned to tasks."""

    name = models.CharField(max_length=255)
    email = models.EmailField(blank=True)
    job_role = models.CharField(max_length=120, blank=True)
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


class Skill(VersionedModel):
    """A capability tag in the global org-level catalog.

    normalized_name is the de-dup key (casefolded + stripped). All reads
    should use name; writes normalise to normalized_name to prevent "React" /
    "react" / "REACT" from producing separate rows.
    """

    name = models.CharField(max_length=120)
    normalized_name = models.CharField(max_length=120, unique=True)
    category = models.CharField(max_length=60, blank=True)

    class Meta:
        db_table = "resources_skill"
        ordering = ["name"]

    def __str__(self) -> str:
        return self.name


class Proficiency(models.IntegerChoices):
    BEGINNER = 1, "Beginner"
    INTERMEDIATE = 2, "Intermediate"
    EXPERT = 3, "Expert"


class ResourceSkill(VersionedModel):
    """A skill tag on a resource with a proficiency level."""

    resource = models.ForeignKey(Resource, on_delete=models.CASCADE, related_name="skills")
    skill = models.ForeignKey(Skill, on_delete=models.PROTECT, related_name="resources")
    proficiency = models.IntegerField(choices=Proficiency.choices, default=Proficiency.INTERMEDIATE)

    class Meta:
        db_table = "resources_resource_skill"
        unique_together = [("resource", "skill")]
        indexes = [models.Index(fields=["skill", "proficiency"])]
        ordering = ["skill__name"]

    def __str__(self) -> str:
        return f"{self.resource} — {self.skill} ({self.get_proficiency_display()})"


class ProjectResource(VersionedModel):
    """A resource's explicit membership in a project's roster.

    Distinct from TaskResource (task assignment) and ProjectMembership (user
    access role). A resource can be on the roster without yet being assigned
    to any task. Per-project overrides for role title and capacity are stored
    here; if null they fall back to Resource.job_role / Resource.max_units.
    """

    project = models.ForeignKey(Project, on_delete=models.CASCADE, related_name="resource_pool")
    resource = models.ForeignKey(
        Resource, on_delete=models.CASCADE, related_name="project_memberships"
    )
    role_title = models.CharField(max_length=120, blank=True)
    units_override = models.DecimalField(max_digits=4, decimal_places=2, null=True, blank=True)
    notes = models.CharField(max_length=500, blank=True)

    class Meta:
        db_table = "resources_project_resource"
        unique_together = [("project", "resource")]
        indexes = [models.Index(fields=["project", "is_deleted"])]

    def __str__(self) -> str:
        return f"{self.resource} on {self.project}"

    @property
    def effective_max_units(self) -> object:
        """Return the project-specific override if set, otherwise the resource default."""
        return self.units_override if self.units_override is not None else self.resource.max_units


class TaskSkillRequirement(VersionedModel):
    """A skill required to work on a task, with a minimum proficiency level.

    Optional — tasks without requirements behave as they do today.
    When present, the assignment picker uses these to annotate resources
    with skill_fit and surface skill_mismatch warnings on assignment.
    """

    task = models.ForeignKey(Task, on_delete=models.CASCADE, related_name="skill_requirements")
    skill = models.ForeignKey(Skill, on_delete=models.PROTECT, related_name="task_requirements")
    min_proficiency = models.IntegerField(choices=Proficiency.choices, default=Proficiency.BEGINNER)

    class Meta:
        db_table = "resources_task_skill_requirement"
        unique_together = [("task", "skill")]
        ordering = ["skill__name"]

    def __str__(self) -> str:
        return f"{self.task} requires {self.skill} ({self.get_min_proficiency_display()}+)"


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
