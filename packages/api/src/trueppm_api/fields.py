"""Custom Django model fields."""

from __future__ import annotations

from typing import Any

from django.core.exceptions import EmptyResultSet
from django.db import models
from django.db.models import Lookup


class LtreeField(models.Field):  # type: ignore[type-arg]
    """PostgreSQL ltree field for hierarchical path storage.

    Stores dotted-label paths (e.g. "1.2.3") that can be queried with
    PostgreSQL ltree operators (<@, @>, ~, ?) via raw SQL or ORM annotations.
    Maps to a GiST-indexed ltree column in PostgreSQL.

    Python representation: a plain string (e.g. "1.2.3" or "").
    """

    description = "PostgreSQL ltree hierarchical path"

    def db_type(self, connection: object) -> str:
        return "ltree"

    def from_db_value(self, value: object, expression: object, connection: object) -> str | None:
        if value is None:
            return None
        return str(value)

    def to_python(self, value: object) -> str | None:
        if value is None:
            return None
        return str(value)

    def get_prep_value(self, value: object) -> str | None:
        if value is None:
            return None
        return str(value)


class _LtreeContainmentLookup(Lookup):
    """Shared SQL plumbing for the ltree subtree lookups below."""

    template: str

    def as_sql(  # type: ignore[override]
        self, compiler: Any, connection: Any
    ) -> tuple[str, list[Any]]:
        lhs, lhs_params = self.process_lhs(compiler, connection)
        rhs, rhs_params = self.process_rhs(compiler, connection)
        # ``rhs`` is a bound text parameter or a column/OuterRef expression; the cast
        # makes it an ltree so the ``<@`` operator (and its GiST opclass) applies.
        sql = self.template.format(lhs=lhs, rhs=f"({rhs})::ltree")
        return sql, [*lhs_params, *rhs_params]


@LtreeField.register_lookup
class DescendantOrEqual(_LtreeContainmentLookup):
    """``wbs_path__descendant_or_equal="1.2"`` -> ``wbs_path <@ '1.2'::ltree``.

    The path itself plus every descendant. Replaces ``wbs_path__startswith``, which
    compiles to ``LIKE 'prefix%'`` and cannot use the ltree GiST index on
    ``projects_task.wbs_path``; ``<@`` can. It also matches whole labels, so ``"1"``
    no longer matches ``"10"`` the way a bare prefix did.
    """

    lookup_name = "descendant_or_equal"
    template = "{lhs} <@ {rhs}"


@LtreeField.register_lookup
class Descendant(_LtreeContainmentLookup):
    """``wbs_path__descendant="1.2"`` -> strict descendants only (``<@`` and not equal).

    The replacement for ``wbs_path__startswith=f"{path}."`` at call sites that mean
    "below this node, excluding it".
    """

    lookup_name = "descendant"

    def as_sql(  # type: ignore[override]
        self, compiler: Any, connection: Any
    ) -> tuple[str, list[Any]]:
        # Fail closed: an empty path is the ltree root, which every non-root path is
        # "below", so ``<@ '' AND <> ''`` would match the whole table. A caller that
        # computed an empty path (missing parent, unset wbs_path) means "no subtree".
        if isinstance(self.rhs, str) and not self.rhs.strip():
            raise EmptyResultSet
        lhs, lhs_params = self.process_lhs(compiler, connection)
        rhs, rhs_params = self.process_rhs(compiler, connection)
        rhs = f"({rhs})::ltree"
        sql = f"({lhs} <@ {rhs} AND {lhs} <> {rhs})"
        return sql, [*lhs_params, *rhs_params, *lhs_params, *rhs_params]
