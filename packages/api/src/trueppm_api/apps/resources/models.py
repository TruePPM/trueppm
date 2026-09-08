"""Resource domain models."""

from __future__ import annotations

import uuid
from typing import TYPE_CHECKING, ClassVar, TypeVar

from django.conf import settings
from django.db import models

from trueppm_api.apps.projects.models import Calendar, Project, Task, VersionedModel

if TYPE_CHECKING:
    from django.db.models import QuerySet

#: THE single definition of "this row hangs off a resource that still counts" (#3572).
#:
#: Deactivating a resource (``DELETE /api/v1/resources/{id}/``) is catalog-only: the
#: ``TaskResource`` rows are deliberately retained so an off-boarding does not erase
#: assignment history (see ``ResourceViewSet.perform_destroy``). That retention is the
#: whole reason this predicate has to exist — the rows survive, so every roster,
#: capacity, and skill read has to exclude the deactivated person *itself*.
#:
#: One expression, imported by one manager method, rather than a
#: ``resource__is_deleted=False`` clause copied into each of a dozen reads. The
#: precedent is ``TaskManager.untouched_seeded``: two call sites that looked like they
#: detected the same fact re-derived it independently, one read the wrong column, and a
#: whole class of load went silently missing (#3572 is that failure again, in reverse —
#: nobody derived it at all).
ACTIVE_RESOURCE = models.Q(resource__is_deleted=False)

_ResourceScoped = TypeVar("_ResourceScoped", bound=models.Model)


class ResourceScopedManager(models.Manager[_ResourceScoped]):
    """Default (unfiltered) manager for a table whose rows hang off a ``Resource``.

    Stays unfiltered so it remains ``_default_manager`` — the audit reads, the
    workspace export, and the "does this task have any assignment at all" structural
    guards all need the retained rows. It exists only so :meth:`active` has one home;
    no manager is registered for migrations, so swapping ``models.Manager`` for this
    class is not a schema change.
    """

    def active(self) -> QuerySet[_ResourceScoped]:
        """Rows whose resource has not been deactivated.

        The read-side half of :data:`ACTIVE_RESOURCE`. Use this for anything that
        answers a *capacity*, *roster*, or *catalog* question — who is on the team,
        how loaded are they, who is over-allocated. Do **not** use it for the audit
        reads: a deactivated person's assignment history is retained on purpose.
        """
        return self.get_queryset().filter(ACTIVE_RESOURCE)


class ResourceSkillManager(ResourceScopedManager["ResourceSkill"]):
    """Skill-tag manager. See :class:`ResourceScopedManager`."""


class TaskResourceManager(ResourceScopedManager["TaskResource"]):
    """Assignment manager. See :class:`ResourceScopedManager`."""


class ProjectResourceManager(ResourceScopedManager["ProjectResource"]):
    """Roster manager: :meth:`active` also excludes rows removed from the roster."""

    def active(self) -> QuerySet[ProjectResource]:
        """Live roster rows whose resource is also live.

        Both halves matter and neither implies the other: ``is_deleted`` is the row's
        own removal (hand removal, or the deactivation cascade in
        ``ResourceViewSet.perform_destroy``), while ``ACTIVE_RESOURCE`` catches a
        resource deactivated before the cascade existed or by a path that bypassed it.
        """
        return self.get_queryset().filter(ACTIVE_RESOURCE).filter(is_deleted=False)


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

    objects: ClassVar[ResourceSkillManager] = ResourceSkillManager()

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
    # The discriminator that makes reactivation reversible (#3572). A roster row can
    # reach is_deleted=True two ways with opposite intent: a person removed the
    # resource from *this* project, or the resource was deactivated org-wide and
    # ResourceViewSet.perform_destroy cascaded. Only the second may be undone by
    # ResourceViewSet.restore — without the flag, restoring a resource would also
    # resurrect memberships somebody deliberately ended, silently re-adding a person
    # to a project they had been taken off.
    deactivated_with_resource = models.BooleanField(default=False)

    objects: ClassVar[ProjectResourceManager] = ProjectResourceManager()

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
        constraints = [
            models.UniqueConstraint(
                fields=["task", "skill"], name="uniq_task_skill_req_task_skill"
            ),
        ]
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

    objects: ClassVar[TaskResourceManager] = TaskResourceManager()

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
