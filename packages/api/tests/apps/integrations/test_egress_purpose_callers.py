"""Every egress call site states its allow-list purpose (#2851).

The per-purpose allow-lists only isolate callers if each caller passes the right
``purpose=``. Every test stub accepts and ignores the keyword, so a dropped
``purpose=`` at an SSO site would pass the whole suite while silently making that
site honor no allow-list (or, worse, the wrong one). This walks the source tree
and requires an explicit decision at every call into the guarded egress helpers.
"""

from __future__ import annotations

import ast
from pathlib import Path

import pytest

SRC = Path(__file__).resolve().parents[3] / "src" / "trueppm_api"
HTTP_MODULE = "trueppm_api.apps.integrations.http"
GUARDED = {"get", "post_form", "assert_url_allowed", "assert_host_allowed", "build_guarded_opener"}
MARKER = "# egress-purpose: none"
SELF = SRC / "apps" / "integrations" / "http.py"


def _resolve(module: ast.ImportFrom, path: Path) -> str:
    """Absolute dotted module name of a (possibly relative) ``from`` import."""
    if module.level == 0:
        return module.module or ""
    pkg = list(path.relative_to(SRC.parent).with_suffix("").parts[:-1])
    pkg = pkg[: len(pkg) - (module.level - 1)]
    return ".".join([*pkg, *([module.module] if module.module else [])])


def _find_unmarked(path: Path) -> list[str]:
    source = path.read_text()
    lines = source.splitlines()
    tree = ast.parse(source)
    module_aliases: set[str] = set()
    func_aliases: dict[str, str] = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom):
            base = _resolve(node, path)
            for a in node.names:
                if base == HTTP_MODULE and a.name in GUARDED:
                    func_aliases[a.asname or a.name] = a.name
                elif f"{base}.{a.name}" == HTTP_MODULE:
                    module_aliases.add(a.asname or a.name)
        elif isinstance(node, ast.Import):
            for a in node.names:
                if a.name == HTTP_MODULE and a.asname:
                    module_aliases.add(a.asname)
    bad: list[str] = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        fn = node.func
        if (
            isinstance(fn, ast.Attribute)
            and isinstance(fn.value, ast.Name)
            and fn.value.id in module_aliases
            and fn.attr in GUARDED
        ):
            name = fn.attr
        elif isinstance(fn, ast.Name) and fn.id in func_aliases:
            name = func_aliases[fn.id]
        else:
            continue
        if any(k.arg == "purpose" for k in node.keywords):
            continue
        # The marker may sit on any line of the call or the line above it.
        end = node.end_lineno or node.lineno
        window = lines[max(node.lineno - 2, 0) : end]
        if any(MARKER in ln for ln in window):
            continue
        bad.append(f"{path.relative_to(SRC.parent)}:{node.lineno} {name}()")
    return bad


def _all_unmarked() -> list[str]:
    out: list[str] = []
    for path in sorted(SRC.rglob("*.py")):
        if path == SELF:
            continue
        out.extend(_find_unmarked(path))
    return out


def test_every_egress_call_states_its_purpose() -> None:
    missing = _all_unmarked()
    assert not missing, (
        "egress call without purpose= (pass the caller's EgressPurpose, or add "
        "'# egress-purpose: none — <reason>'):\n" + "\n".join(missing)
    )


def test_guard_detects_a_dropped_purpose(tmp_path: Path) -> None:
    """The walker itself is not vacuous: it flags an unmarked call and honors the marker."""
    f = SRC / "apps" / "sso" / "_tmp_probe.py"
    f.write_text(
        "from trueppm_api.apps.integrations import http as egress\n"
        "egress.get('x')\n"
        "# egress-purpose: none — test\n"
        "egress.get('y')\n"
        "egress.get('z', purpose=1)\n"
    )
    try:
        found = _find_unmarked(f)
    finally:
        f.unlink()
    assert len(found) == 1 and ":2 get()" in found[0]


@pytest.mark.parametrize("name", sorted(GUARDED))
def test_guarded_names_exist_in_the_http_module(name: str) -> None:
    assert f"def {name}(" in SELF.read_text()
