"""Functional index on ``UPPER(auth_user.email)`` for the ``email__iexact`` lookups (#3504).

Seven call sites resolve a person by email on ``auth.User``: the login email
fallback and password reset (``core``), OIDC account linking (``apps.sso``),
workspace invite acceptance and the duplicate-member guard (``apps.workspace``),
inbound Jira assignee mapping (``apps.projects``), and the
``revoke_api_tokens`` command (``apps.access``).

Six of the seven are served by this index; ``revoke_api_tokens`` is not. It
matches ``Q(username__iexact=...) | Q(email__iexact=...)`` in one query, and an
OR across two columns can only use indexes when *both* sides have one — there is
no ``UPPER(username)`` index, and adding one to speed up an interactive admin
command is not worth a second functional index on the same table.

**Why a functional index and not ``db_index``.** On PostgreSQL Django compiles
``iexact`` through ``lookup_cast()`` to ``UPPER("auth_user"."email"::text) =
UPPER(%s)``. A plain btree on ``email`` indexes the *column*, not that
expression, so the planner cannot use it — the index has to be built on the same
``UPPER(email::text)`` expression the query filters on. The SQL above is the
verbatim expression Django emits, so the two match exactly.

**Why raw SQL.** ``auth.User`` is a ``django.contrib`` model we do not own, so
``Meta.indexes`` is unavailable. Per CLAUDE.md's migration discipline this is the
narrow case where the ORM genuinely cannot express the operation. It is
deliberately **DB-only with no ``state_operations``**: adding the index to
Django's migration state would describe a model this app does not own and make
``makemigrations --check`` demand a ``RemoveIndex``.

**Why this app.** No single consumer owns the index — the seven call sites span
``core``, ``sso``, ``workspace``, ``projects`` and ``access``. ``profiles`` is
the app whose domain *is* the auth user record (``UserProfile`` is its 1:1
extension), and it already carries a swappable dependency on
``AUTH_USER_MODEL``, so it is the natural home for a schema addition to
``auth_user`` itself.

**Why NOT ``CREATE INDEX CONCURRENTLY``** (this deviates from the SQL proposed on
the issue, deliberately). ``CONCURRENTLY`` cannot run inside a transaction and
therefore forces ``atomic = False``. The three existing concurrent-index
migrations (``projects`` 0090/0100/0105) each justify that cost by table size —
they build on the largest and highest-volume tables in the schema, where a
``ShareLock`` is user-visible during a rolling deploy. ``auth_user`` is the
inverse: ``administration/sizing.md`` puts the envelope at a team of 25 to a team
of 250, so the table is in the low hundreds of rows and the in-transaction build
holds its lock for well under a millisecond.

Against that non-benefit, ``atomic = False`` carries a real hazard here.
Migrations run on container start, and a ``CREATE INDEX CONCURRENTLY`` that
fails part-way leaves an **INVALID** index behind: the planner ignores it while
every write still maintains it. Combined with the ``IF NOT EXISTS`` guard below,
the retry would then *silently skip* the invalid index, record the migration as
applied, and leave the index permanently non-functional with nothing in the
output saying so. An atomic build simply rolls back and fails loudly.

An operator running far outside the documented envelope, where the plain build
would take a noticeable lock, can pre-build the index by hand with
``CREATE INDEX CONCURRENTLY auth_user_email_upper_idx ON auth_user
(UPPER(email::text));`` before upgrading — ``IF NOT EXISTS`` then makes this
migration a verified no-op.
"""

from __future__ import annotations

from django.db import migrations

_INDEX = "auth_user_email_upper_idx"


class Migration(migrations.Migration):
    dependencies = [
        ("profiles", "0008_remove_userprofile_schedule_in_deliver"),
        # auth_user must exist (and be at its final column shape) before we index
        # an expression over one of its columns.
        ("auth", "0012_alter_user_first_name_max_length"),
    ]

    operations = [
        migrations.RunSQL(
            sql=(f"CREATE INDEX IF NOT EXISTS {_INDEX} ON auth_user (UPPER(email::text));"),
            reverse_sql=f"DROP INDEX IF EXISTS {_INDEX};",
        ),
    ]
