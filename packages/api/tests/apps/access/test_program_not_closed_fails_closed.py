"""``IsProgramNotClosed.has_object_permission`` fails CLOSED on unresolvable scope (#4498).

Split out of #3587, which flipped the same fail-open branch on the project-lifecycle
sibling (``IsProjectNotArchived``). ``IsProgramNotClosed`` uses its own separate
resolver (``_get_program_id_from_obj``, not ``_get_project_id_from_obj``), which is
why ``test_route_table_invariants.py``'s ``test_the_scope_family_is_discoverable``
explicitly asserts it stays out of the ``_resolve_program_scope`` family — this was a
different, undocumented fail-open survivor of the same shape, found on the program
side after #3587 closed it on the project side.

No database is touched for the resolver-mechanics assertions: every object graph here
is a plain in-memory object, not a model row — the one case that does need a real
``Program`` row still never queries beyond the create, because ``has_object_permission``
reads the in-memory ``is_closed`` flag directly for a ``Program`` instance rather than
re-fetching it.

#4498's own audit (recorded in the fix commit message, not a dedicated route-table
invariant like #3587's — the program-scoped write surface carrying this class is much
smaller: ``BacklogItemViewSet``, ``ProgramUserDefinedMentionGroupViewSet``,
``ExternalStakeholderViewSet``, ``ProgramMembershipViewSet``, ``CeremonyTemplateViewSet``,
``PhaseGateConfigView``, ``ProgramWebhookViewSet``, ``ProgramViewSet`` itself, and
``ProgramApiTokenViewSet``) found that every (route, action) pair where this class is
effective and the view carries no class-level ``queryset`` either never actually reaches
``has_object_permission`` with an unresolvable object (``create`` never calls
``check_object_permissions`` against a not-yet-existing row — DRF's ``CreateModelMixin``
hands it no object at all, matching the #3587 finding for ``ProjectApiTokenViewSet``), or
resolves against a direct ``Program`` instance or a non-nullable ``program``/
``program_id`` FK. The model-resolution cases below are the direct-FK half of that
audit; the never-fires half has no unit to write (there is nothing to call).
"""

from __future__ import annotations

import pytest
from rest_framework.request import Request
from rest_framework.test import APIRequestFactory
from rest_framework.views import APIView

from trueppm_api.apps.access.models import ProgramUserDefinedMentionGroup, Role
from trueppm_api.apps.access.permissions import IsProgramNotClosed
from trueppm_api.apps.projects.models import (
    BacklogItem,
    CeremonyCadenceType,
    CeremonyTemplate,
    Program,
)


class _Opaque:
    """No ``program_id``, ``program``, or any other walkable attribute.

    The exact shape ``_get_program_id_from_obj`` cannot resolve — not a nullable FK
    (which the resolver would still see via ``hasattr``), genuinely nothing to walk.
    """


def _request(method: str = "POST") -> Request:
    return Request(APIRequestFactory().generic(method, "/"))


@pytest.mark.parametrize("method", ["POST", "PUT", "PATCH", "DELETE"])
def test_unsafe_methods_fail_closed_on_an_unresolvable_object(method: str) -> None:
    """The fix: an unsafe write against an object with no program hop is now refused.

    Before #4498 this returned ``True`` — the permission layer could not tell what
    program the write touched and permitted it anyway, the same fail-open shape
    #3587 closed on ``IsProjectNotArchived``.
    """
    view = APIView()
    assert IsProgramNotClosed().has_object_permission(_request(method), view, _Opaque()) is False


@pytest.mark.parametrize("method", ["GET", "HEAD", "OPTIONS"])
def test_safe_methods_still_pass_regardless_of_resolution(method: str) -> None:
    """Reads are unaffected — the SAFE_METHODS branch returns True before resolution
    is ever attempted, exactly as it did before this fix."""
    view = APIView()
    assert IsProgramNotClosed().has_object_permission(_request(method), view, _Opaque()) is True


@pytest.mark.parametrize("action", ["reopen", "destroy", "close", "remove_sample"])
def test_the_program_lifecycle_bypass_actions_still_pass_regardless(action: str) -> None:
    """``reopen``/``destroy``/``close``/``remove_sample`` on ``ProgramViewSet`` itself
    bypass before program-id resolution is ever reached — unaffected by this fix,
    and still the escape hatch that lets an Owner reopen or delete a closed program."""
    from trueppm_api.apps.projects.program_views import ProgramViewSet

    view = ProgramViewSet()
    view.action = action
    assert IsProgramNotClosed().has_object_permission(_request("POST"), view, _Opaque()) is True


@pytest.mark.django_db
def test_a_resolvable_live_program_object_still_permits_a_write() -> None:
    """The common, correct path is unchanged: a resolvable, non-closed program
    still permits the write — this fix only changes the *unresolvable* branch."""
    program = Program.objects.create(name="Live")
    view = APIView()
    assert IsProgramNotClosed().has_object_permission(_request("POST"), view, program) is True


@pytest.mark.django_db
def test_a_resolvable_closed_program_object_still_refuses() -> None:
    """Likewise, the closed-and-resolvable path is unchanged by this fix."""
    program = Program.objects.create(name="Closed", is_closed=True)
    view = APIView()
    assert IsProgramNotClosed().has_object_permission(_request("POST"), view, program) is False


@pytest.mark.django_db
def test_backlog_item_resolves_via_its_non_nullable_program_fk() -> None:
    """``BacklogItemViewSet`` (list/retrieve/create/update/destroy/pull) is the
    #4498 audit's largest surface — proves the model it hands to
    ``check_object_permissions`` resolves rather than falling into the fixed branch."""
    program = Program.objects.create(name="Prog")
    item = BacklogItem.objects.create(program=program, title="Item")
    view = APIView()
    assert IsProgramNotClosed().has_object_permission(_request("POST"), view, item) is True


@pytest.mark.django_db
def test_ceremony_template_resolves_via_its_non_nullable_program_fk() -> None:
    """``CeremonyTemplateViewSet`` update/destroy hand the row itself to
    ``check_object_permissions`` via DRF's default ``get_object()``."""
    program = Program.objects.create(name="Prog")
    template = CeremonyTemplate.objects.create(
        program=program, name="Weekly Sync", cadence_type=CeremonyCadenceType.WEEKLY
    )
    view = APIView()
    assert IsProgramNotClosed().has_object_permission(_request("PATCH"), view, template) is True


@pytest.mark.django_db
def test_mention_group_resolves_via_its_non_nullable_program_fk() -> None:
    """``ProgramUserDefinedMentionGroupViewSet`` ``mute``/``unmute``/
    ``partial_update``/``destroy`` hand the row itself via DRF's default
    ``get_object()``."""
    program = Program.objects.create(name="Prog")
    group = ProgramUserDefinedMentionGroup.objects.create(program=program, name="tech-leads")
    view = APIView()
    assert IsProgramNotClosed().has_object_permission(_request("PATCH"), view, group) is True


@pytest.mark.django_db
def test_program_membership_resolves_via_its_non_nullable_program_fk(
    django_user_model: type,
) -> None:
    """``ProgramMembershipViewSet`` ``partial_update`` hands the row itself via DRF's
    default ``get_object()`` (``destroy`` deliberately does not carry this class —
    see ``ProgramMembershipViewSet.get_permissions``'s own docstring)."""
    from trueppm_api.apps.access.models import ProgramMembership

    program = Program.objects.create(name="Prog")
    user = django_user_model.objects.create_user(username="carol", password="pw")
    membership = ProgramMembership.objects.create(program=program, user=user, role=Role.VIEWER)
    view = APIView()
    assert IsProgramNotClosed().has_object_permission(_request("PATCH"), view, membership) is True


@pytest.mark.django_db
def test_external_stakeholder_resolves_via_its_non_nullable_program_fk() -> None:
    """``ExternalStakeholderViewSet`` update/destroy hand the row itself via DRF's
    default ``get_object()`` (``create`` never calls ``check_object_permissions`` at
    all, so it never reaches this branch regardless of resolution)."""
    from trueppm_api.apps.access.models import ExternalStakeholder

    program = Program.objects.create(name="Prog")
    stakeholder = ExternalStakeholder.objects.create(
        program=program, name="Vendor Contact", email="vendor@example.com"
    )
    view = APIView()
    assert IsProgramNotClosed().has_object_permission(_request("PATCH"), view, stakeholder) is True
