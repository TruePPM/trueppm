"""Resource domain models."""

from __future__ import annotations

import uuid
from decimal import Decimal

from django.conf import settings
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
    # Optional link to the User this resource represents. Drives the
    # "My tasks" filter on the Board (issue #198) without relying on email
    # matching. Nullable so non-human resources (teams, equipment) and
    # legacy rows (created before this FK existed) remain valid.
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        related_name="resources",
        null=True,
        blank=True,
    )

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
        constraints = [
            models.UniqueConstraint(
                fields=["resource", "skill"], name="uniq_resource_skill_resource_skill"
            ),
        ]
        indexes = [models.Index(fields=["skill", "proficiency"], name="res_skill_prof_idx")]
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
    notes = models.TextField(blank=True, default="")

    class Meta:
        db_table = "resources_project_resource"
        constraints = [
            models.UniqueConstraint(
                fields=["project", "resource"], name="uniq_project_resource_project_resource"
            ),
        ]
        indexes = [models.Index(fields=["project", "is_deleted"], name="proj_res_proj_del_idx")]

    def __str__(self) -> str:
        return f"{self.resource} on {self.project}"

    @property
    def effective_max_units(self) -> Decimal:
        """Return the project-specific override if set, otherwise the resource default.

        Delegates to :func:`trueppm_api.apps.resources.capacity.effective_units`, the
        single definition of this fallback (#1582) — the same one every per-project
        capacity read applies, so no two surfaces can resolve it differently (#3574).
        """
        from trueppm_api.apps.resources.capacity import effective_units

        # ``self.resource`` is dereferenced ONLY when there is no override, so a
        # roster row loaded without select_related does not trigger a query it does
        # not need. The rule itself still lives in one place.
        override = self.units_override
        return effective_units(override, None if override is not None else self.resource.max_units)


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
        constraints = [
            models.UniqueConstraint(
                fields=["task", "skill"], name="uniq_task_skill_req_task_skill"
            ),
        ]
        ordering = ["skill__name"]

    def __str__(self) -> str:
        return f"{self.task} requires {self.skill} ({self.get_min_proficiency_display()}+)"

    @property
    def project_id(self) -> object:
        """Expose the task's project_id so _get_project_id_from_obj can find it.

        The same shape, and the same reason, as ``TaskResource.project_id`` below: the
        resolver walks ``project_id`` / ``project`` / ``predecessor`` and nothing else,
        and it returns ``None`` — which ``IsProjectNotArchived.has_object_permission``
        reads as "permitted" — for a model that reaches its project only through ``task``.
        Declaring the permission class without this property is a fail-open that reads as
        a gate (#3570). Deliberately a property rather than a widening of the resolver:
        #3414 removed a generic ``task_id -> task.project_id`` hop because it would have
        flipped eleven fail-closed classes from deny to role-based grant on models that
        never intended to be project-scoped.
        """
        return self.task.project_id


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
        constraints = [
            models.UniqueConstraint(
                fields=["task", "resource"], name="uniq_task_resource_task_resource"
            ),
        ]

    def __str__(self) -> str:
        return f"{self.resource} on {self.task} ({self.units}u)"

    @property
    def project_id(self) -> object:
        """Expose the task's project_id so _get_project_id_from_obj can find it.

        Required for CanAssignResource.has_object_permission to resolve the project
        context from a TaskResource instance without a direct FK to Project.
        """
        return self.task.project_id
