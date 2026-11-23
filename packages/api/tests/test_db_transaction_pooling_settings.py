"""#2275 — TRUEPPM_DB_TRANSACTION_POOLING flips the settings a transaction pooler needs."""

from __future__ import annotations

import json
import os
import subprocess
import sys

import pytest


def _load(pooling: str | None) -> dict[str, object]:
    env = {k: v for k, v in os.environ.items() if k != "TRUEPPM_DB_TRANSACTION_POOLING"}
    if pooling is not None:
        env["TRUEPPM_DB_TRANSACTION_POOLING"] = pooling
    env["DJANGO_SETTINGS_MODULE"] = "trueppm_api.settings.dev"
    code = (
        "import json; from django.conf import settings; d = settings.DATABASES['default'];"
        "print(json.dumps({k: d.get(k) for k in "
        "('DISABLE_SERVER_SIDE_CURSORS','CONN_HEALTH_CHECKS','ATOMIC_REQUESTS')}))"
    )
    out = subprocess.run(
        [sys.executable, "-c", code], env=env, capture_output=True, text=True, check=True
    )
    return json.loads(out.stdout.strip().splitlines()[-1])


@pytest.mark.parametrize("value", [None, "false"])
def test_default_leaves_server_side_cursors_and_health_checks_alone(value: str | None) -> None:
    cfg = _load(value)
    assert not cfg["DISABLE_SERVER_SIDE_CURSORS"]
    assert not cfg["CONN_HEALTH_CHECKS"]
    assert cfg["ATOMIC_REQUESTS"] is True


def test_transaction_pooling_disables_server_side_cursors_and_pings_reused_connections() -> None:
    cfg = _load("true")
    assert cfg["DISABLE_SERVER_SIDE_CURSORS"] is True
    assert cfg["CONN_HEALTH_CHECKS"] is True
    assert cfg["ATOMIC_REQUESTS"] is True
