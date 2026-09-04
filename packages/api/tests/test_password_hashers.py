"""Tests for the test-only fast password hasher in settings.dev (#3391).

Django 5.2 defaults to PBKDF2-SHA256 at 1,000,000 iterations. The suite makes
~1,054 `create_user(..., password=...)` calls and asserts nothing about hash
strength, so under pytest we swap in MD5 (measured 2,899x faster). The two
things worth pinning are that the swap is actually in effect during a test run,
and that it is gated narrowly enough that a `runserver` on the same settings
module does not inherit it.
"""

from __future__ import annotations

import re
from pathlib import Path

from django.conf import settings
from django.contrib.auth.hashers import get_hasher

from trueppm_api.settings import dev as dev_module
from trueppm_api.settings.dev import _use_fast_password_hashers


def test_pytest_run_uses_the_fast_hasher() -> None:
    """Under pytest the active hasher is MD5, not the 1M-iteration PBKDF2."""
    assert settings.PASSWORD_HASHERS == ["django.contrib.auth.hashers.MD5PasswordHasher"]
    assert get_hasher("default").algorithm == "md5"


def test_predicate_is_true_when_pytest_is_imported() -> None:
    """The gate keys on pytest being in the module table."""
    assert _use_fast_password_hashers({"pytest": object()}) is True


def test_predicate_is_false_without_pytest() -> None:
    """A runserver process — no pytest imported — keeps the production hasher.

    This is the assertion that matters: settings.dev is also what `make up` and
    a local `manage.py runserver` load, and a developer must not be logging in
    against a weaker algorithm than the one they ship.
    """
    assert _use_fast_password_hashers({}) is False
    assert _use_fast_password_hashers({"django": object(), "mypy": object()}) is False


def test_production_settings_do_not_weaken_hashing() -> None:
    """settings.prod must never carry the test hasher override.

    Read as source rather than imported: prod.py enforces its guards at import
    time and refuses to load without ALLOWED_HOSTS/SECRET_KEY set, so importing
    it here to inspect an attribute would test the guard instead of the hasher.
    The property under test is textual anyway — the override must not appear in
    that module, nor in the shared base it inherits from.
    """
    settings_dir = Path(dev_module.__file__).parent
    others = sorted(p for p in settings_dir.glob("*.py") if p.name not in {"dev.py", "__init__.py"})
    # Globbed rather than hardcoded: a future staging.py must be covered the day
    # it lands, not the day somebody remembers to add it to a literal list.
    assert others, "no non-dev settings modules found — the glob is wrong"
    for module in others:
        source = module.read_text()
        assert "PASSWORD_HASHERS" not in source, module.name
        assert "MD5PasswordHasher" not in source, module.name


def test_no_module_under_src_imports_pytest() -> None:
    """The gate rests on this, and nothing else enforces it.

    `_use_fast_password_hashers` keys on `"pytest" in sys.modules`, which is safe
    only while no module Django imports at startup pulls pytest in. The realistic
    regression is mundane: a shared test factory or a `pytest.importorskip` shim
    lands under src/, a developer with the dev extra installed runs `runserver`
    plus `create_admin`, and their database quietly gets MD5 hashes with no
    signal anywhere. Grep-shaped rather than import-shaped so it cannot itself
    import the thing it is checking for.
    """
    src = Path(dev_module.__file__).parents[1]
    assert src.name == "trueppm_api", f"expected the package root, got {src}"

    pattern = re.compile(r"^\s*(?:import\s+pytest|from\s+pytest[\s.]|import\s+_pytest)", re.M)
    offenders = [
        path.relative_to(src) for path in src.rglob("*.py") if pattern.search(path.read_text())
    ]
    assert not offenders, (
        "these shipped modules import pytest, which would make settings.dev "
        f"install the test-only MD5 hasher in a runserver process: {offenders}"
    )
