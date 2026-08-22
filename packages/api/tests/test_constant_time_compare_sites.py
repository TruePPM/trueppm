"""``compare_digest`` has exactly one home in this codebase (#2881, #2929).

``hmac.compare_digest`` (and ``secrets.compare_digest``, which is the same
object) raises ``TypeError`` on a non-ASCII ``str``. DRF does not convert
``TypeError``, so a site that passes it a request-derived string 500s on input
any anonymous caller can send — and the sites that compare a secret against
caller input are, by construction, the anonymously reachable ones.

That defect shipped twice. #2881 fixed the Git-webhook receiver by comparing
bytes, and left the fix as a private helper in that module; ten months later the
SSO OIDC callback had the identical line (#2929). A second copy of a guard is
how a third site appears silently, so the fix is one shared primitive plus this
test, which fails the moment a new direct caller shows up.

The rule is deliberately blunt — *no* direct ``compare_digest`` call outside
``core/constant_time.py``, whether or not its arguments look request-derived.
Proving an argument is not caller-controlled needs whole-program dataflow;
"route it through the primitive" needs a grep, and the primitive is correct for
the ASCII-only case too.
"""

from __future__ import annotations

import ast
from pathlib import Path

_API_ROOT = Path(__file__).resolve().parents[1]
_SRC_DIR = _API_ROOT / "src" / "trueppm_api"

# The single sanctioned home. Every other module delegates to it.
_PRIMITIVE_MODULE = _SRC_DIR / "core" / "constant_time.py"


def _calls_compare_digest(source: str) -> bool:
    """True if ``source`` calls ``compare_digest``, bare or attribute-qualified."""
    for node in ast.walk(ast.parse(source)):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        if isinstance(func, ast.Attribute) and func.attr == "compare_digest":
            return True
        if isinstance(func, ast.Name) and func.id == "compare_digest":
            return True
    return False


def test_the_primitive_still_calls_compare_digest() -> None:
    """Pin the discovery — a rename that empties the scan must not pass vacuously."""
    assert _PRIMITIVE_MODULE.is_file(), f"{_PRIMITIVE_MODULE} is gone; this test is now vacuous"
    assert _calls_compare_digest(_PRIMITIVE_MODULE.read_text())


def test_no_module_outside_the_primitive_calls_compare_digest() -> None:
    offenders = sorted(
        str(module.relative_to(_SRC_DIR))
        for module in _SRC_DIR.rglob("*.py")
        if module != _PRIMITIVE_MODULE and _calls_compare_digest(module.read_text())
    )
    assert offenders == [], (
        "compare_digest raises TypeError on non-ASCII str and DRF does not convert it, "
        "so these modules can 500 on caller-controlled input. Call "
        "trueppm_api.core.constant_time.constant_time_equal instead: " + ", ".join(offenders)
    )
