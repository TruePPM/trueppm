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
