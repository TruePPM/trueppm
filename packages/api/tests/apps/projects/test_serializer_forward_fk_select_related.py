"""Class guard: forward FKs read by SprintSerializer getters must be select_related.

#4382 was one instance (``milestone_bound_by`` read in a SerializerMethodField,
not joined by the viewset, so the list ran one query per bound sprint). This
derives the set of Sprint forward FKs the serializer's getters dereference
(``obj.<fk>``) straight from the serializer source, so the next getter that
reads a forward FK fails here until SprintViewSet.queryset joins it.
"""

from __future__ import annotations

import inspect
import re

from trueppm_api.apps.projects.models import Sprint
from trueppm_api.apps.projects.serializers import SprintSerializer
from trueppm_api.apps.projects.views import SprintViewSet


def _forward_fks_read_by_getters() -> set[str]:
    fk_names = {f.name for f in Sprint._meta.get_fields() if f.many_to_one and f.concrete}
    read: set[str] = set()
    for name, member in inspect.getmembers(SprintSerializer, inspect.isfunction):
        if not name.startswith("get_"):
            continue
        read |= set(re.findall(r"\bobj\.(\w+)", inspect.getsource(member))) & fk_names
    return read


def test_sprint_getter_forward_fks_are_select_related() -> None:
    read = _forward_fks_read_by_getters()
    # Sanity: the derivation must see the known instances, or it is vacuous.
    assert {"milestone_bound_by", "target_milestone", "project"} <= read
    joined = SprintViewSet.queryset.query.select_related
    assert isinstance(joined, dict)
    missing = read - set(joined)
    assert not missing, f"SprintViewSet.queryset must select_related {sorted(missing)}"
