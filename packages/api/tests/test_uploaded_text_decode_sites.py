"""Delimited-text importers decode through one shared module (#2892, #2937).

Decoding an upload is not ``.decode()``. cp1252 and latin-1 map almost every
byte, so a wrong guess *succeeds* and produces mojibake; and strict UTF-8 does
not save you either, because NUL is a valid UTF-8 code point, so a BOM-less
UTF-16 stream sails through it. Getting this right needs BOM sniffing, an
ordered codec ladder, and an output check — which is why it must exist once.

#2892 fixed the task CSV importer and left the logic private to that module.
Three months later the risk-register importer had the identical defect (#2937):
same class, second app, and nothing anywhere could have noticed. That is the
gap this test closes.

The rule is scoped by an imported primitive rather than a hand-maintained list,
following ``test_untrusted_parser_security_coverage.py``: a module in ``apps/``
that imports ``csv`` is parsing delimited text, and delimited text it did not
decode itself came from an upload. Deliberately **not** a repo-wide ban on
``.decode(`` — there are ~29 legitimate calls (base64 to ASCII, internal JSON,
subprocess output), and a rule that misfires on those would be suppressed,
taking the real protection with it.
"""

from __future__ import annotations

import ast
from pathlib import Path

_API_ROOT = Path(__file__).resolve().parents[1]
_SRC_DIR = _API_ROOT / "src" / "trueppm_api"
_APPS_DIR = _SRC_DIR / "apps"

#: The sanctioned home. Every delimited-text importer delegates to it.
_DECODER_MODULE = _SRC_DIR / "core" / "text_decode.py"

#: Importing this means the module parses delimited text.
_DELIMITED_TEXT_PRIMITIVE = "csv"


def _imports_csv(tree: ast.AST) -> bool:
    """True if the module imports ``csv``, at module level or inside a function."""
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            if any(a.name.split(".")[0] == _DELIMITED_TEXT_PRIMITIVE for a in node.names):
                return True
        elif (
            isinstance(node, ast.ImportFrom)
            and node.module
            and node.level == 0
            and node.module.split(".")[0] == _DELIMITED_TEXT_PRIMITIVE
        ):
            return True
    return False


def _decode_call_lines(tree: ast.AST) -> list[int]:
    """Line numbers of every ``<something>.decode(...)`` call in the module."""
    return [
        node.lineno
        for node in ast.walk(tree)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and node.func.attr == "decode"
    ]


def _delimited_text_modules() -> dict[Path, ast.AST]:
    trees: dict[Path, ast.AST] = {}
    for module in _APPS_DIR.rglob("*.py"):
        tree = ast.parse(module.read_text())
        if _imports_csv(tree):
            trees[module] = tree
    return trees


def test_the_known_delimited_text_importers_are_still_discovered() -> None:
    """Pin the discovery — a refactor that empties the set must not pass vacuously."""
    found = {p.relative_to(_APPS_DIR).as_posix() for p in _delimited_text_modules()}
    assert {"csvimport/parser.py", "projects/risk_import.py"} <= found, (
        f"the delimited-text importers are no longer discoverable by their csv import: {found}"
    )


def test_the_shared_decoder_exists_and_owns_the_decoding() -> None:
    assert _DECODER_MODULE.is_file(), f"{_DECODER_MODULE} is gone; this test is now vacuous"
    assert _decode_call_lines(ast.parse(_DECODER_MODULE.read_text())), (
        "the shared decoder no longer calls .decode(); the rule below now protects nothing"
    )


def test_no_delimited_text_importer_decodes_its_own_bytes() -> None:
    offenders = sorted(
        f"{path.relative_to(_SRC_DIR).as_posix()}:{line}"
        for path, tree in _delimited_text_modules().items()
        for line in _decode_call_lines(tree)
    )
    assert offenders == [], (
        "A module that parses delimited text is decoding upload bytes itself. That is "
        "the #2892/#2937 defect class: a wrong codec succeeds and yields mojibake "
        "rather than an error. Call "
        "trueppm_api.core.text_decode.decode_uploaded_text and translate "
        "TextDecodeError into this app's own exception: " + ", ".join(offenders)
    )
