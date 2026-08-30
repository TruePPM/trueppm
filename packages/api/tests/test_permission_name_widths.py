"""First-boot guard for ``post_migrate`` permission creation (#3081).

Django's ``create_permissions`` runs on every ``migrate`` and bulk-inserts one
``auth.Permission`` row per (model, action). Two things decide whether that
insert fits:

* the **name** it generates — ``"Can %s %s" % (action, verbose_name_raw)``; and
* the width of ``auth_permission.name`` **in the migration state the plan
  produced**, which is 50 after ``auth.0001_initial`` and 255 only once
  ``auth.0002_alter_permission_name_max_length`` has run.

A *full* ``migrate`` always applies auth.0002, so deploys never saw this. A
*targeted* ``migrate <app> <n>`` against an empty database applies only the
dependency closure of the target — which pulled ``auth`` in at 0001 and left the
column at varchar(50). ``projects`` generates two 51-character names from a
simple-history shadow model, so the insert died with ``DataError: value too long
for type character varying(50)`` after every migration had already applied.

The fix is a migration edge, so the test is on the migration graph rather than on
the model: it replays each offending app's dependency closure from an **empty**
state — exactly what first boot does — and asserts the ``Permission.name`` width
Django would hand ``create_permissions`` is wide enough for the names that app
generates. Deliberately no ``importlib.import_module`` of a migration module and
no hard-coded migration filename: roots are resolved through the graph, so a
squash cannot silently disarm this.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

import pytest
from django.apps import apps as global_apps
from django.contrib.auth import get_permission_codename
from django.db.migrations.loader import MigrationLoader
from django.db.migrations.state import ProjectState

if TYPE_CHECKING:
    # Annotation-only: `from __future__ import annotations` keeps these strings at
    # runtime, and Options is generic in django-stubs but not subscriptable in Django.
    from django.db.models import Model
    from django.db.models.options import Options

# Hard ceilings from django.contrib.auth.models.Permission on a fully migrated
# database. Exceeding either breaks a plain `migrate` too, not just a targeted one.
PERMISSION_NAME_MAX = 255
PERMISSION_CODENAME_MAX = 100

# Width of auth_permission.name after auth.0001_initial and before auth.0002.
# An app generating a longer name must force auth.0002 into its own closure.
NARROW_PERMISSION_NAME_WIDTH = 50

# The migration that performs the widening. Named rather than derived, so
# test_the_widening_migration_still_exists below pins it to reality: if a Django
# upgrade renames or renumbers it, that test fails loudly instead of letting the
# closure assertions drift into passing for the wrong reason.
AUTH_WIDENING_MIGRATION = ("auth", "0002_alter_permission_name_max_length")


def _permissions_for(opts: Options[Model]) -> list[tuple[str, str]]:
    """Return ``[(codename, name), ...]`` exactly as ``create_permissions`` builds them.

    Reimplements ``django.contrib.auth.management._get_all_permissions`` on public
    API only — that helper is private and absent from django-stubs, and pinning a
    test to it would break the typecheck on a Django upgrade for no benefit. The
    name format ``"Can %s %s"`` and the ``default_permissions`` + ``Meta.permissions``
    union are documented behavior.
    """
    builtin = [
        (get_permission_codename(action, opts), f"Can {action} {opts.verbose_name_raw}")
        for action in opts.default_permissions
    ]
    return [*builtin, *opts.permissions]


def _generated_permissions() -> dict[str, list[tuple[str, str]]]:
    """Return ``{app_label: [(codename, name), ...]}`` for every installed model."""
    out: dict[str, list[tuple[str, str]]] = {}
    for app_config in global_apps.get_app_configs():
        if not app_config.models_module:
            continue
        for model in app_config.get_models():
            out.setdefault(app_config.label, []).extend(_permissions_for(model._meta))
    return out


def _permission_name_width_at(node: tuple[str, str], loader: MigrationLoader) -> int | None:
    """Replay ``node``'s dependency closure from empty and report the column width.

    This is the first-boot path: ``ProjectState()`` is an empty database, and the
    resulting state is what ``migrate`` passes to ``post_migrate`` as
    ``post_migrate_apps``. ``mutate_state`` is pure in-memory state, so no
    database is touched.

    Returns ``None`` when ``auth`` is absent from the closure entirely. That is a
    *pass*, not an error: ``create_permissions`` does ``apps.get_model("auth",
    "Permission")`` against the same state and returns early on ``LookupError``,
    so nothing is inserted and nothing can overflow. Five app roots in this repo
    already build such a state, so the branch is reachable rather than defensive.
    """
    state = ProjectState()
    for dep in loader.graph.forwards_plan(node):
        loader.graph.nodes[dep].mutate_state(state, preserve=False)
    permission = state.models.get(("auth", "permission"))
    if permission is None:
        return None
    return int(permission.fields["name"].max_length)


@pytest.fixture(scope="module")
def loader() -> MigrationLoader:
    # connection=None reads migrations from disk only — no database required.
    return MigrationLoader(None, ignore_no_migrations=True)


def test_the_widening_migration_still_exists(loader: MigrationLoader) -> None:
    """Pin AUTH_WIDENING_MIGRATION to a migration that actually exists.

    The width constants and the migration name are hard-coded from Django's auth
    app. If an upgrade renames or renumbers that migration, every assertion built
    on it would quietly stop meaning what it says — this fails first instead.
    """
    assert AUTH_WIDENING_MIGRATION in loader.disk_migrations, (
        f"{AUTH_WIDENING_MIGRATION} is gone from django.contrib.auth — the widths "
        "in this module were derived from it and need rechecking (#3081)"
    )


def test_no_permission_name_exceeds_the_fully_migrated_column() -> None:
    """A name over 255 would break even a complete `migrate` (#3081)."""
    generated = _generated_permissions()
    assert generated, "no app generated any permission — this test asserted nothing"
    too_long = [
        (label, len(name), name)
        for label, perms in generated.items()
        for _codename, name in perms
        if len(name) > PERMISSION_NAME_MAX
    ]
    assert not too_long, (
        f"auth_permission.name is varchar({PERMISSION_NAME_MAX}); shorten the "
        f"model's verbose_name: {too_long}"
    )


def test_no_permission_codename_exceeds_the_column() -> None:
    """Codename is varchar(100) at every migration state, squash or not."""
    generated = _generated_permissions()
    assert generated, "no app generated any permission — this test asserted nothing"
    too_long = [
        (label, len(codename), codename)
        for label, perms in generated.items()
        for codename, _name in perms
        if len(codename) > PERMISSION_CODENAME_MAX
    ]
    assert not too_long, (
        f"auth_permission.codename is varchar({PERMISSION_CODENAME_MAX}); "
        f"shorten the model class name: {too_long}"
    )


def test_apps_with_long_permission_names_force_the_auth_widening(
    loader: MigrationLoader,
) -> None:
    """Targeted `migrate <app> <n>` on an empty database must not hit varchar(50).

    For every app whose generated permission names overflow the pre-auth.0002
    column, replay its root closure from empty and require the widened column.
    Without the ``("auth", "0002_alter_permission_name_max_length")`` dependency
    on ``projects``' initial migration this fails at 50 < 51 — the #3081 repro,
    caught without building a database.
    """
    checked = 0
    for label, perms in sorted(_generated_permissions().items()):
        longest = max((len(name) for _codename, name in perms), default=0)
        if longest <= NARROW_PERMISSION_NAME_WIDTH:
            continue
        roots = loader.graph.root_nodes(label)
        assert roots, f"app {label!r} generates permissions but has no migrations"
        for root in roots:
            checked += 1
            width = _permission_name_width_at(root, loader)
            if width is None:
                # auth absent from the closure — create_permissions returns early
                # on LookupError, so nothing is inserted and nothing can overflow.
                continue
            assert width >= longest, (
                f"{label}.{root[1]} builds an empty database with "
                f"auth_permission.name = varchar({width}), but {label} generates a "
                f"permission name of {longest} chars. post_migrate's "
                f"create_permissions() will raise DataError on first boot. Add "
                f'("auth", "0002_alter_permission_name_max_length") to that '
                f"migration's dependencies (#3081)."
            )
    # Guards the guard: if nothing overflows 50 any more the loop body never ran,
    # and this test would pass without asserting anything. `projects` is expected
    # to keep at least one long name; if that legitimately changes, drop this line
    # rather than letting a vacuous test look green.
    assert checked, (
        "no app generates a permission name over "
        f"{NARROW_PERMISSION_NAME_WIDTH} chars — this test asserted nothing"
    )


def test_every_root_migration_on_disk_declares_the_widening_itself(
    loader: MigrationLoader,
) -> None:
    """Each copy of the auth.0002 edge must stand on its own.

    The test above reads the *merged* graph, where ``remove_replaced_nodes``
    re-points a replaced migration's dependencies onto its replacement. That makes
    the two copies of the edge mask each other: delete either one and the graph
    still resolves to varchar(255), so the assertion above stays green. Only
    deleting both turns it red.

    That is the wrong shape for a fix whose stated rationale is durability — the
    copy on the replaced original is the one that survives a future
    ``squashmigrations`` regeneration (CLAUDE.md migration rule 6 puts a squash on
    every minor-release checklist), and it is precisely the copy someone would
    delete as "redundant". So assert against ``disk_migrations``, which retains
    replaced originals, and require every root migration *as written on disk* to
    declare the edge itself.
    """
    checked = 0
    for label, perms in sorted(_generated_permissions().items()):
        longest = max((len(name) for _codename, name in perms), default=0)
        if longest <= NARROW_PERMISSION_NAME_WIDTH:
            continue
        disk_roots = [
            key
            for key, migration in loader.disk_migrations.items()
            if key[0] == label and not any(dep[0] == label for dep in migration.dependencies)
        ]
        assert disk_roots, f"app {label!r} has no root migration on disk"
        for key in disk_roots:
            checked += 1
            deps = loader.disk_migrations[key].dependencies
            assert AUTH_WIDENING_MIGRATION in deps, (
                f"{key[0]}/{key[1]}.py is a root migration for an app that "
                f"generates a {longest}-character permission name, but does not "
                f"declare {AUTH_WIDENING_MIGRATION} itself. The merged graph may "
                f"still resolve via a sibling root, so the closure test will not "
                f"catch this — and the edge would be lost the next time this app's "
                f"history is squashed. Restore it (#3081)."
            )
    assert checked, (
        "no app generates a permission name over "
        f"{NARROW_PERMISSION_NAME_WIDTH} chars — this test asserted nothing"
    )
