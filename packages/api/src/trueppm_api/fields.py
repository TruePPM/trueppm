"""Custom Django model fields."""

from __future__ import annotations

from django.db import models


class LtreeField(models.Field):
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
