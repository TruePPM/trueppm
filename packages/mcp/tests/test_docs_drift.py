"""Guard the human-facing tool count against the registered-tool surface (#1807).

The PyPI landing page (``README.md``) states a tool count in prose. That number
drifted from the real surface once (README said 14 while the server registered
18) — a user-facing accuracy bug in the same class as the version-tense rule.
This test binds the prose count to the actual registered set so it can never
silently drift again: add or remove a tool and this fails until the README is
updated to match.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from trueppm_mcp.client import TruePPMClient
from trueppm_mcp.config import Settings
from trueppm_mcp.server import build_server

README = Path(__file__).resolve().parent.parent / "README.md"

#: Matches the prose claim "**N read-only tools**" on the README landing page.
_COUNT_RE = re.compile(r"\*\*(\d+) read-only tools\*\*")


async def test_readme_tool_count_matches_registered_surface(settings: Settings) -> None:
    """The README's advertised tool count equals the registered-tool count."""
    client = TruePPMClient(settings)
    try:
        server = build_server(client)
        tools = await server.list_tools()
    finally:
        await client.aclose()

    match = _COUNT_RE.search(README.read_text(encoding="utf-8"))
    assert match is not None, "README no longer states a '**N read-only tools**' count"
    assert int(match.group(1)) == len(tools), (
        f"README advertises {match.group(1)} read-only tools but the server "
        f"registers {len(tools)}; update packages/mcp/README.md to match."
    )


# --- #4636: no recipe may publish the unauthenticated HTTP transport on every host interface ---

_REPO_ROOT = Path(__file__).resolve().parents[3]
_RECIPE_FILES = [
    Path(__file__).resolve().parent.parent / "Dockerfile",
    Path(__file__).resolve().parent.parent / "README.md",
    _REPO_ROOT / "packages/website/src/content/docs/administration/mcp-server.md",
]
#: Oldest ``mcp`` SDK with the FastMCP loopback DNS-rebinding default.
_MIN_SAFE_SDK = (1, 23)


@pytest.mark.parametrize("path", _RECIPE_FILES, ids=lambda p: p.name)
def test_no_recipe_publishes_on_all_interfaces(path: Path) -> None:
    """``-p 8000:8000`` (all host interfaces) must never accompany ``--host 0.0.0.0``."""
    text = path.read_text(encoding="utf-8")
    unsafe = re.compile(
        r"-p\s+(?:0\.0\.0\.0:)?\d+:\d+\b[^`]*?"
        r"--host\s+0\.0\.0\.0",
        re.DOTALL,
    )
    # Join shell line continuations (and Dockerfile comment prefixes) before matching.
    flat = re.sub(r"\\\n\s*(?:#\s*)?", " ", text)
    assert not unsafe.search(flat), (
        f"{path.name} publishes the HTTP transport on all host interfaces"
    )
    assert "loopback equivalent" not in text


def test_sdk_floor_has_dns_rebinding_default() -> None:
    pyproject = Path(__file__).resolve().parent.parent / "pyproject.toml"
    match = re.search(r'"mcp\[cli\]>=(\d+)\.(\d+)', pyproject.read_text(encoding="utf-8"))
    assert match is not None
    assert (int(match.group(1)), int(match.group(2))) >= _MIN_SAFE_SDK
