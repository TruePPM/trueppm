"""FastMCP server assembly for TruePPM (ADR-0186).

The server boots, authenticates against the configured instance, and registers
the read-only tool surface (#504). The ``ApiToken`` ``mcp:read`` scope slice
(#601) lands separately; this module is the seam both register against.
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Callable
from contextlib import AbstractAsyncContextManager, asynccontextmanager

from mcp.server.fastmcp import FastMCP

from trueppm_mcp.client import TruePPMClient
from trueppm_mcp.tools import register_tools

#: MCP server name advertised to clients in the initialize handshake.
SERVER_NAME = "trueppm"

#: Server-level instructions shown to the model so it understands the surface.
SERVER_INSTRUCTIONS = (
    "Read-only access to a self-hosted TruePPM instance: query the live schedule, "
    "tasks, board, risks, sprints, and My Work. Every answer is computed "
    "server-side by TruePPM's own engine under your existing role-based "
    "permissions. Read-only by design — no tool can modify data."
)


def make_lifespan(
    client: TruePPMClient,
) -> Callable[[FastMCP[TruePPMClient]], AbstractAsyncContextManager[TruePPMClient]]:
    """Build the server lifespan that verifies auth at boot and closes the client.

    A token that does not authenticate fails the boot with a clear error rather
    than letting every individual tool 401 later. Extracted from
    :func:`build_server` so this load-bearing auth-at-startup path is unit-testable
    without standing up a transport.
    """

    @asynccontextmanager
    async def lifespan(_server: FastMCP[TruePPMClient]) -> AsyncIterator[TruePPMClient]:
        await client.verify_auth()
        try:
            yield client
        finally:
            await client.aclose()

    return lifespan


def build_server(
    client: TruePPMClient,
    *,
    host: str = "127.0.0.1",
    port: int = 8000,
) -> FastMCP[TruePPMClient]:
    """Construct the FastMCP server bound to an API client.

    Authentication is verified once at startup via the server lifespan (see
    :func:`make_lifespan`). The client is closed on shutdown.

    Args:
        client: The :class:`~trueppm_mcp.client.TruePPMClient` every tool will use.
        host: Bind host for the HTTP/SSE transports (ignored for stdio).
        port: Bind port for the HTTP/SSE transports (ignored for stdio).

    Returns:
        A configured :class:`FastMCP` instance with the read-only tools registered.
    """
    server: FastMCP[TruePPMClient] = FastMCP(
        SERVER_NAME,
        instructions=SERVER_INSTRUCTIONS,
        host=host,
        port=port,
        lifespan=make_lifespan(client),
    )
    # The #504 read-tool surface. Each tool closes over ``client`` — the same
    # instance the lifespan authenticates at boot and closes on shutdown.
    register_tools(server, client)
    return server
