"""Every parser of untrusted uploaded bytes must carry a malicious-input test (#2853).

Three app modules parse request-supplied files — ``msproject`` and ``jiraimport``
(XML, hardened by defusedxml) and ``csvimport`` (xlsx, i.e. a zip archive). Two
of the three shipped with a positive control for their named security property;
the third did not, and CI was green for the whole time it was missing.

The gap was not "someone forgot a test" so much as "nothing enumerates the
class". This test does the enumeration: it discovers the parsers by the
primitive they import rather than by a hand-maintained list, so the *fourth*
untrusted-input parser fails at merge time instead of at a CVE report.

It deliberately checks only that a malicious-input test *exists* for each app —
asserting anything about its contents would duplicate the tests themselves.
"""

from __future__ import annotations

import ast
from pathlib import Path

_API_ROOT = Path(__file__).resolve().parents[1]
_APPS_DIR = _API_ROOT / "src" / "trueppm_api" / "apps"
_TESTS_DIR = _API_ROOT / "tests" / "apps"

# Importing any of these means the module reads a container format that carries
# its own attack surface: entity expansion / external entities for XML, and
# decompression bombs for zip-backed formats.
_UNTRUSTED_PARSE_PRIMITIVES = frozenset({"defusedxml", "zipfile", "openpyxl"})

# A test function whose name contains one of these is a malicious-input positive
# control (billion laughs, XXE, DOCTYPE abuse, zip bomb).
_MALICIOUS_INPUT_MARKERS = ("entity", "xxe", "doctype", "bomb", "malicious")


def _imported_roots(source: str) -> set[str]:
    """Root package names imported anywhere in ``source``, including in-function."""
    roots: set[str] = set()
    for node in ast.walk(ast.parse(source)):
        if isinstance(node, ast.Import):
            roots.update(alias.name.split(".")[0] for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module and node.level == 0:
            roots.add(node.module.split(".")[0])
    return roots


def _apps_parsing_untrusted_input() -> set[str]:
    apps: set[str] = set()
    for module in _APPS_DIR.glob("*/*.py"):
        if _imported_roots(module.read_text()) & _UNTRUSTED_PARSE_PRIMITIVES:
            apps.add(module.parent.name)
    return apps


def _has_malicious_input_test(app: str) -> bool:
    for test_module in (_TESTS_DIR / app).glob("test_*.py"):
        for node in ast.walk(ast.parse(test_module.read_text())):
            if not isinstance(node, ast.FunctionDef):
                continue
            name = node.name.lower()
            if name.startswith("test_") and any(m in name for m in _MALICIOUS_INPUT_MARKERS):
                return True
    return False


def test_the_known_untrusted_parsers_are_still_discovered() -> None:
    """Pin the discovery itself — a rename that empties the set must not pass vacuously."""
    assert _apps_parsing_untrusted_input() >= {"msproject", "jiraimport", "csvimport"}


def test_every_untrusted_input_parser_has_a_malicious_input_test() -> None:
    missing = sorted(
        app for app in _apps_parsing_untrusted_input() if not _has_malicious_input_test(app)
    )
    assert not missing, (
        f"These apps parse untrusted uploaded bytes but carry no malicious-input test: {missing}. "
        f"Add one whose name contains any of {_MALICIOUS_INPUT_MARKERS} — see "
        f"tests/apps/jiraimport/test_parser_security.py for the shape."
    )
