"""URL routing for the resources app."""

from __future__ import annotations

from rest_framework.routers import DefaultRouter

from trueppm_api.apps.resources.views import (
    ProjectResourceViewSet,
    ResourceSkillViewSet,
    ResourceViewSet,
    SkillViewSet,
    TaskResourceViewSet,
    TaskSkillRequirementViewSet,
)

router = DefaultRouter()
router.register(r"resources", ResourceViewSet, basename="resource")
router.register(r"task-resources", TaskResourceViewSet, basename="task-resource")
router.register(r"skills", SkillViewSet, basename="skill")
router.register(r"resource-skills", ResourceSkillViewSet, basename="resource-skill")
router.register(r"project-resources", ProjectResourceViewSet, basename="project-resource")
router.register(
    r"task-skill-requirements",
    TaskSkillRequirementViewSet,
    basename="task-skill-requirement",
)

urlpatterns = router.urls
