"""Re-run ``create_default_teams`` as a real forward step on an upgrading database.

The ``teams`` app has no unsquashed released history: ``0001_initial`` and
``0002_default_teams`` both first shipped already combined into
``0001_squashed_0002_default_teams`` (v0.3.0-alpha.1). So, unlike every other app's
restored elidable data op (#4320), there has never been a released state that an
upgrading database could pass through where the original, elidable
``create_default_teams`` op was guaranteed to run from the originals rather than the
squash. An install upgrading from before teams existed (pre-0.3, with real ``Project``
and ``ProjectMembership`` rows already present) applies *only* the squash for this
app — and until this branch's commit restoring the op to the squash, that squash
carried no data step at all, so ``create_default_teams`` never ran for it and never
will on its own (the squash is recorded as applied; Django will not re-run it).

This migration closes that gap directly instead of relying on the squash restoration,
which only helps installs that have not yet applied the squash. It is intentionally
NOT elidable, so a future squash spanning this migration cannot silently drop it
again the way the optimizer dropped the original. ``create_default_teams`` is
``get_or_create``-shaped (see its docstring in ``0002_default_teams.py``), so re-running
it here is a safe no-op on every install that already has default teams — whether
because the squash's restored op already created them on a fresh install, or because
``teams.signals``' membership-signal healing filled the gap already.
"""

from __future__ import annotations

import importlib

from django.db import migrations

# The source module's file name starts with a digit, so it cannot be named in a
# normal `from ... import ...` statement; resolve it the same way the squash's
# `_original` helper does (0001_squashed_0002_default_teams.py).
# nosemgrep: python.lang.security.audit.non-literal-import.non-literal-import
_default_teams_module = importlib.import_module(
    "trueppm_api.apps.teams.migrations.0002_default_teams"
)
_create_default_teams = _default_teams_module.create_default_teams


class Migration(migrations.Migration):
    dependencies = [
        ("teams", "0003_team_sync_seq_teammembership_sync_seq"),
        ("access", "0001_initial"),
    ]

    operations = [
        migrations.RunPython(_create_default_teams, migrations.RunPython.noop),
    ]
