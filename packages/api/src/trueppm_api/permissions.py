"""Top-level permission re-exports for backward compatibility.

All real permission classes and the ProjectScopedViewSet mixin live in
trueppm_api.apps.access.permissions. This module re-exports them so that
any code that imported from here continues to work without changes.
"""

from __future__ import annotations

from trueppm_api.apps.access.permissions import (
    IsProjectAdmin,
    IsProjectMember,
    IsProjectMemberWrite,
    IsProjectOwner,
    IsProjectScheduler,
    ProjectScopedViewSet,
)

# Explicit re-export surface: this shim exists purely so callers that imported
# permissions from here keep working (trueppm-enterprise registers against it).
# Listing the names in ``__all__`` marks them as an intentional public export,
# which is also what tells static analysis they are not dead imports.
__all__ = [
    "IsProjectAdmin",
    "IsProjectMember",
    "IsProjectMemberWrite",
    "IsProjectOwner",
    "IsProjectScheduler",
    "ProjectScopedViewSet",
]
