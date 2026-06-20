"""Tests for the _on_program_create_seed_rollup post_save receiver (#848 backfill).

A new Program must come online with methodology-aware rollup defaults already
seeded (VoC: 6/8 personas wanted no day-one configuration). The receiver fires
only on create and only when the config is still empty, so user-supplied values
and plain re-saves are never clobbered. ``rollup_config_defaults`` is the single
source of truth shared with the backfill migration.
"""

from __future__ import annotations

import pytest

from trueppm_api.apps.projects.models import Program
from trueppm_api.apps.projects.services import rollup_config_defaults


@pytest.mark.django_db
def test_program_create_seeds_methodology_defaults() -> None:
    program = Program.objects.create(name="Seeded")
    enabled, policy = rollup_config_defaults(program.methodology)

    program.refresh_from_db()
    assert program.rollup_enabled_kpis == enabled
    assert program.rollup_aggregation_policy == policy
    # The defaults are non-empty — the seed actually populated something.
    assert program.rollup_enabled_kpis


@pytest.mark.django_db
def test_program_create_respects_preexisting_config() -> None:
    # When the caller supplies rollup_enabled_kpis up front, the receiver must
    # not overwrite it (idempotency / future service-layer create path).
    program = Program.objects.create(name="Custom", rollup_enabled_kpis=["schedule_health"])
    program.refresh_from_db()
    assert program.rollup_enabled_kpis == ["schedule_health"]


@pytest.mark.django_db
def test_program_resave_does_not_reseed() -> None:
    program = Program.objects.create(name="Resaved")
    program.refresh_from_db()
    # Simulate a user who narrowed the seeded set, then re-saves the Program.
    program.rollup_enabled_kpis = []
    program.save(update_fields=["rollup_enabled_kpis"])
    program.refresh_from_db()
    # created=False → the receiver bails out; the empty set is preserved, not reseeded.
    assert program.rollup_enabled_kpis == []
