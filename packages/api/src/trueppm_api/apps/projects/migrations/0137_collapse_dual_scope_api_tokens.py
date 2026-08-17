"""Collapse ``['legacy:full', 'mcp:read']`` tokens to ``['legacy:full']`` (#2877).

Both mint paths now reject the combination (``_normalize_token_scopes``), but rows
predating that validation still carry it, and since #2877 the scope list is the single
hinge the whole MCP control layer turns on:
:func:`~trueppm_api.apps.projects.models.is_agent_token` resolves a dual-scope token to
*not an agent* (full authority), while ``MyApiTokenSerializer`` keeps listing
``mcp:read`` and the settings UI keeps labeling it "Read-only for AI assistants".

Stripping ``mcp:read`` makes stored state match resolved posture, so the runtime
tie-break becomes dead-code defense rather than the only thing standing between an
operator and a token whose UI label contradicts its behavior. It is behavior-preserving
by construction: ``legacy:full`` already granted a superset of ``mcp:read``, so nothing
the token could do before it can no longer do.

Not reversible in a meaningful sense — re-adding ``mcp:read`` would recreate the
ambiguity the forward migration exists to remove — so the reverse is a documented no-op
rather than a fake inverse.
"""

from __future__ import annotations

from typing import Any

from django.db import migrations

SCOPE_LEGACY_FULL = "legacy:full"
SCOPE_MCP_READ = "mcp:read"


def collapse_dual_scope_tokens(apps: Any, schema_editor: Any) -> None:
    ApiToken = apps.get_model("projects", "ApiToken")
    # Iterate rather than a single ArrayField `update`: the rows are bounded (10 active
    # personal tokens per user plus a handful of integration tokens) and preserving each
    # row's own remaining scope order is clearer than assembling a SQL array expression.
    for token in ApiToken.objects.filter(scopes__contains=[SCOPE_LEGACY_FULL, SCOPE_MCP_READ]).only(
        "pk", "scopes"
    ):
        remaining = [scope for scope in (token.scopes or []) if scope != SCOPE_MCP_READ]
        ApiToken.objects.filter(pk=token.pk).update(scopes=remaining or [SCOPE_LEGACY_FULL])


def noop_reverse(apps: Any, schema_editor: Any) -> None:
    """Deliberately does nothing — see the module docstring."""


class Migration(migrations.Migration):
    dependencies = [
        ("projects", "0136_schedule_outline_batch_operations"),
    ]

    operations = [
        migrations.RunPython(collapse_dual_scope_tokens, noop_reverse),
    ]
